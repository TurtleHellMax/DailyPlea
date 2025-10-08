// routes-dm.js
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { db } = require('./db');
const { requireAuth } = require('./routes-auth');
const mm = require('music-metadata');
const zlib = require('zlib');
const gunzip = zlib.promises?.gunzip
    ? (b) => zlib.promises.gunzip(b)
    : (b) =>
        new Promise((resolve, reject) =>
            zlib.gunzip(b, (err, out) => (err ? reject(err) : resolve(out)))
        );
const path = require('path');
const fs = require('fs');

const router = express.Router();

/* ====== config / crypto ====== */
const UPLOADS_ROOT = path.join(__dirname, 'uploads');
const EMOJI_DIR = path.join(UPLOADS_ROOT, 'custom-emojis');
try {
    fs.mkdirSync(EMOJI_DIR, { recursive: true });
} catch { }

const uploadEmoji = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 512 * 1024 }, // 512 KB per emoji sprite
});

const MASTER_KEY_HEX = process.env.DM_MASTER_KEY || ''; // 64 hex chars (32 bytes)
if (!/^[0-9a-fA-F]{64}$/.test(MASTER_KEY_HEX || '')) {
    console.warn(
        '[DM] WARNING: DM_MASTER_KEY not set (or not 64 hex). Generating ephemeral key; encrypted data will be unreadable across restarts.'
    );
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
function encryptJSON(key, obj) {
    return aeadEncrypt(key, Buffer.from(JSON.stringify(obj)));
}
function decryptJSON(key, cipher, nonce) {
    const plain = aeadDecrypt(key, cipher, nonce);
    return JSON.parse(Buffer.isBuffer(plain) ? plain.toString('utf8') : String(plain));
}

/* ====== feature flags from DB ====== */
function hasDurationCol() {
    try {
        const cols = db.prepare(`PRAGMA table_info(dm_attachments)`).all();
        return Array.isArray(cols) && cols.some((c) => String(c.name).toLowerCase() === 'duration_ms');
    } catch {
        return false;
    }
}
function msgHasCols(...names) {
    try {
        const cols = db.prepare(`PRAGMA table_info(dm_messages)`).all();
        const set = new Set(cols.map((c) => String(c.name).toLowerCase()));
        return names.every((n) => set.has(n.toLowerCase()));
    } catch {
        return false;
    }
}
const HAS_MSG_DELETE_SNAPSHOT = msgHasCols('deletable_at_send', 'delete_window_sec_at_send');
const HAS_MSG_REACTION_SNAPSHOT = msgHasCols('reactable', 'reaction_mode_at_send');

/* ====== audio helpers ====== */
function readVintId(buf, off) {
    const b = buf[off];
    if (b === undefined) return null;
    let l = 1,
        m = 0x80;
    while (l <= 4 && (b & m) === 0) {
        m >>= 1;
        l++;
    }
    if (l > 4 || off + l > buf.length) return null;
    let v = b;
    for (let i = 1; i < l; i++) v = (v << 8) | buf[off + i];
    return { length: l, value: v >>> 0 };
}
function readVintSize(buf, off) {
    const b = buf[off];
    if (b === undefined) return null;
    let l = 1,
        m = 0x80;
    while (l <= 8 && (b & m) === 0) {
        m >>= 1;
        l++;
    }
    if (l > 8 || off + l > buf.length) return null;
    let v = b & (m - 1);
    for (let i = 1; i < l; i++) v = (v << 8) | buf[off + i];
    const unknown = v === (1 << (7 * l)) - 1;
    return { length: l, value: v >>> 0, unknown };
}
function walkEbml(buf, start, end, onEl) {
    let off = start | 0;
    const L = end | 0;
    while (off < L) {
        const id = readVintId(buf, off);
        if (!id) break;
        off += id.length;
        const sz = readVintSize(buf, off);
        if (!sz) break;
        off += sz.length;
        const s = off,
            e = sz.unknown ? L : Math.min(L, off + sz.value);
        onEl(id.value, s, e);
        off = e;
    }
}
function readUIntBE(buf, off, len) {
    if (off + len > buf.length) return null;
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + buf[off + i];
    return v >>> 0;
}
function readFloat(buf, off, len) {
    if (len === 4 && off + 4 <= buf.length) return buf.readFloatBE(off);
    if (len === 8 && off + 8 <= buf.length) return buf.readDoubleBE(off);
    return NaN;
}
function estimateWebmDurationMs(bufIn) {
    const buf = Buffer.isBuffer(bufIn) ? bufIn : Buffer.from(bufIn);
    let segStart = 0,
        segEnd = buf.length;
    walkEbml(buf, 0, buf.length, (id, s, e) => {
        if (id === 0x18538067) {
            segStart = s;
            segEnd = e;
        }
    }); // Segment
    let scale = 1_000_000; // default TimecodeScale = 1ms in ns
    let infoDurSec = null;

    // Info element: TimecodeScale (0x2AD7B1), Duration (0x4489)
    walkEbml(buf, segStart, segEnd, (id, s, e) => {
        if (id !== 0x1549a966) return;
        walkEbml(buf, s, e, (cid, cs, ce) => {
            if (cid === 0x2ad7b1) {
                const n = readUIntBE(buf, cs, Math.min(8, ce - cs));
                if (n) scale = n;
            } else if (cid === 0x4489) {
                const v = readFloat(buf, cs, ce - cs);
                if (Number.isFinite(v) && v > 0) infoDurSec = v;
            }
        });
    });
    if (Number.isFinite(infoDurSec) && infoDurSec > 0) return Math.round(infoDurSec * (scale / 1e6));

    // Fallback: clusters
    let maxMs = 0;
    walkEbml(buf, segStart, segEnd, (id, s, e) => {
        if (id !== 0x1f43b675) return; // Cluster
        let cTc = 0;
        walkEbml(buf, s, e, (cid, cs) => {
            if (cid === 0xe7) {
                const v = readUIntBE(buf, cs, 8);
                if (typeof v === 'number') cTc = v;
            }
        });
        walkEbml(buf, s, e, (cid, cs, ce) => {
            if (cid === 0xa3) {
                const tnum = readVintSize(buf, cs);
                if (!tnum) return;
                const off = cs + tnum.length;
                if (off + 2 > ce) return;
                const rel = buf.readInt16BE(off);
                const endMs = (cTc + Math.max(0, rel) + 1) * (scale / 1e6);
                if (endMs > maxMs) maxMs = endMs;
            } else if (cid === 0xa0) {
                let rel = 0,
                    dur = 0;
                walkEbml(buf, cs, ce, (gid, gs, ge) => {
                    if (gid === 0xa1) {
                        const tnum = readVintSize(buf, gs);
                        if (tnum) {
                            const off = gs + tnum.length;
                            if (off + 2 <= ge) rel = buf.readInt16BE(off);
                        }
                    } else if (gid === 0x9b) {
                        const v = readUIntBE(buf, gs, Math.min(8, ge - gs));
                        if (typeof v === 'number') dur = v;
                    }
                });
                const endMs = (cTc + Math.max(0, rel) + Math.max(0, dur)) * (scale / 1e6);
                if (endMs > maxMs) maxMs = endMs;
            }
        });
    });
    return maxMs > 0 ? Math.round(maxMs) : null;
}
function sniffContainer(buf) {
    const B = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (B.length >= 2 && B[0] === 0x1f && B[1] === 0x8b) return 'gzip';
    if (B.length >= 4 && B[0] === 0x1a && B[1] === 0x45 && B[2] === 0xdf && B[3] === 0xa3) return 'webm';
    if (B.length >= 4 && B.toString('ascii', 0, 4) === 'OggS') return 'ogg';
    if (B.length >= 12 && B.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
    if (B.length >= 12 && B.toString('ascii', 0, 4) === 'RIFF' && B.toString('ascii', 8, 12) === 'WAVE') return 'wav';
    return 'unknown';
}
function estimateOggOpusDurationMs(bufIn) {
    const B = Buffer.isBuffer(bufIn) ? bufIn : Buffer.from(bufIn);
    let off = 0,
        lastGp = 0,
        serial = null;
    while (off + 27 <= B.length && B.toString('ascii', off, off + 4) === 'OggS') {
        const pageSegs = B[off + 26];
        const segTable = off + 27;
        if (segTable + pageSegs > B.length) break;
        let bodyLen = 0;
        for (let i = 0; i < pageSegs; i++) bodyLen += B[segTable + i];
        if (segTable + pageSegs + bodyLen > B.length) break;
        const gp = B.readUInt32LE(off + 6) + B.readUInt32LE(off + 10) * 0x100000000;
        const s = B.readUInt32LE(off + 14);
        if (serial == null) serial = s;
        if (s === serial && gp > 0) lastGp = gp;
        off = segTable + pageSegs + bodyLen;
    }
    return lastGp > 0 ? Math.round((lastGp / 48000) * 1000) : null;
}
async function probeAudioDurationMsFromBuffer(bufIn, mime, encoding /* 'gzip' | null */) {
    let buf = Buffer.isBuffer(bufIn) ? bufIn : Buffer.from(bufIn);

    const sniff0 = sniffContainer(buf);
    if (encoding?.toLowerCase() === 'gzip' || sniff0 === 'gzip') {
        try {
            buf = await gunzip(buf);
        } catch { }
    }
    const kind = sniffContainer(buf);

    try {
        const fileInfo = {
            size: buf.length,
            mimeType: kind === 'webm' ? 'video/webm' : mime || 'application/octet-stream',
        };
        const info = await mm.parseBuffer(buf, fileInfo, { duration: true });
        const sec = info?.format?.duration;
        if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
    } catch { }

    if (kind === 'ogg') {
        const ms = estimateOggOpusDurationMs(buf);
        if (Number.isFinite(ms) && ms > 0) return ms;
    }
    if (kind === 'webm') {
        const ms = estimateWebmDurationMs(buf);
        if (Number.isFinite(ms) && ms > 0) return ms;
    }
    return null;
}

/* ====== user / conv helpers ====== */
function findUserBySlugOrId(slug) {
    if (/^\d+$/.test(slug)) return db.prepare(`SELECT * FROM users WHERE id=?`).get(+slug);
    return db
        .prepare(
            `
    SELECT * FROM users
    WHERE lower(first_username)=lower(?) OR lower(username)=lower(?)
    LIMIT 1
  `
        )
        .get(slug, slug);
}
function isMember(convId, userId) {
    const r = db
        .prepare(`SELECT 1 FROM dm_members WHERE conversation_id=? AND user_id=? LIMIT 1`)
        .get(convId, userId);
    return !!r;
}
function ensureConvKey(convId) {
    const row = db
        .prepare(`SELECT key_cipher, key_nonce FROM dm_conversation_keys WHERE conversation_id=?`)
        .get(convId);
    if (row) return;
    const convKey = crypto.randomBytes(32);
    const enc = aeadEncrypt(MASTER_KEY, convKey);
    db.prepare(
        `INSERT OR REPLACE INTO dm_conversation_keys(conversation_id, key_cipher, key_nonce) VALUES(?,?,?)`
    ).run(convId, enc.cipher, enc.nonce);
}
function getOrCreateConvKey(convId) {
    let row = db
        .prepare(`SELECT key_cipher, key_nonce FROM dm_conversation_keys WHERE conversation_id=?`)
        .get(convId);
    if (!row) {
        const convKey = crypto.randomBytes(32);
        const enc = aeadEncrypt(MASTER_KEY, convKey);
        db.prepare(
            `INSERT INTO dm_conversation_keys(conversation_id, key_cipher, key_nonce) VALUES(?,?,?)`
        ).run(convId, enc.cipher, enc.nonce);
        return convKey;
    }
    try {
        return aeadDecrypt(MASTER_KEY, row.key_cipher, row.key_nonce);
    } catch (e) {
        console.warn('[DM] conv key decrypt failed for', convId, e.message, '-> rotating');
        const convKey = crypto.randomBytes(32);
        const enc = aeadEncrypt(MASTER_KEY, convKey);
        db.prepare(`UPDATE dm_conversation_keys SET key_cipher=?, key_nonce=? WHERE conversation_id=?`).run(
            enc.cipher,
            enc.nonce,
            convId
        );
        return convKey;
    }
}
function getUserLabel(userId) {
    const u = db.prepare(`SELECT first_username, username FROM users WHERE id=?`).get(userId);
    return u?.first_username || u?.username || 'User';
}
function listMemberUsers(convId) {
    return db
        .prepare(
            `
    SELECT u.id, u.first_username, u.username
    FROM dm_members m JOIN users u ON u.id=m.user_id
    WHERE m.conversation_id=?
    ORDER BY u.id
  `
        )
        .all(convId);
}
function memberCount(convId) {
    const r = db
        .prepare(`SELECT COUNT(*) AS n FROM dm_members WHERE conversation_id=?`)
        .get(convId);
    return r?.n | 0;
}
function areFriends(a, b) {
    const [x, y] = a < b ? [a, b] : [b, a];
    const r = db
        .prepare(`SELECT 1 FROM friendships WHERE user_id_a=? AND user_id_b=?`)
        .get(x, y);
    return !!r;
}
function getConv(convId) {
    return db
        .prepare(
            `SELECT id, is_group, title, owner_id, color, deleted_at FROM dm_conversations WHERE id=?`
        )
        .get(convId);
}
function softDeleteGroup(convId) {
    const tx = db.transaction(() => {
        db.prepare(`UPDATE dm_conversations SET deleted_at = CURRENT_TIMESTAMP WHERE id=?`).run(convId);
        db.prepare(`INSERT INTO dm_deleted_groups(conversation_id, deleted_at) VALUES(?, CURRENT_TIMESTAMP)`).run(
            convId
        );
        db.prepare(`DELETE FROM dm_conversations WHERE id=?`).run(convId);
    });
    tx();
}
function ensureActiveGroup(convId) {
    const c = getConv(convId);
    if (!c) return { error: 'not_found' };
    if (c.deleted_at) return { error: 'deleted' };
    if (!c.is_group) return { error: 'not_group' };
    return { conv: c };
}
function addSystemMessage(convId, actorId, text) {
    const key = getOrCreateConvKey(convId);
    if (!key) throw new Error('key_missing');
    const enc = encryptJSON(key, { text });
    const id = db
        .prepare(
            `
    INSERT INTO dm_messages(conversation_id, sender_id, kind, body_cipher, body_nonce)
    VALUES(?,?,?,?,?)
  `
        )
        .run(convId, actorId, 'system', enc.cipher, enc.nonce).lastInsertRowid;

    broadcast(convId, 'new', { id }, String(id));
    broadcastToUsersOfConv(convId, 'message', { conversation_id: convId, id }, String(id));
    return id;
}

/* ====== settings (conversation-level defaults) ====== */
function ensureConvSettings(convId) {
    const row = db
        .prepare(
            `SELECT conversation_id, allow_delete, delete_window_sec,
              reactable, reaction_mode, receipts_enabled, updated_at
       FROM dm_settings WHERE conversation_id=?`
        )
        .get(convId);
    if (row) return row;

    // defaults for a brand new conversation
    db.prepare(
        `
    INSERT INTO dm_settings(
      conversation_id,
      allow_delete, delete_window_sec,
      reactable, reaction_mode,
      receipts_enabled, updated_at
    ) VALUES (?, 1, NULL, 1, 'both', 1, CURRENT_TIMESTAMP)
  `
    ).run(convId);

    return db.prepare(`SELECT * FROM dm_settings WHERE conversation_id=?`).get(convId);
}

/* ====== delete / reactions — per-message policy ====== */
function canDeleteMessageForUser(msgRow, userId) {
    if (!msgRow) return false;
    if ((msgRow.sender_id | 0) !== (userId | 0)) return false; // author-only

    // Prefer per-message snapshot
    if (HAS_MSG_DELETE_SNAPSHOT) {
        if (!msgRow.deletable_at_send) return false;
        const win = msgRow.delete_window_sec_at_send;
        if (win == null) return true; // infinite window
        const msgTs = new Date(msgRow.created_at).getTime();
        const ageSec = ((Date.now() - msgTs) / 1000) | 0;
        return ageSec <= Math.max(0, win | 0);
    }

    // Fallback to conversation settings if snapshot cols don't exist
    const st = ensureConvSettings(msgRow.conversation_id);
    if (!st.allow_delete) return false;
    const win = st.delete_window_sec;
    if (win == null) return true;
    const msgTs = new Date(msgRow.created_at).getTime();
    const ageSec = ((Date.now() - msgTs) / 1000) | 0;
    return ageSec <= Math.max(0, win | 0);
}
function getMessagePolicy(msgId) {
    let row;
    if (HAS_MSG_REACTION_SNAPSHOT) {
        row = db.prepare(`
      SELECT m.conversation_id,
             m.reactable             AS msg_reactable,
             m.reaction_mode_at_send AS msg_mode
      FROM dm_messages m
      WHERE m.id=?
    `).get(msgId);
    } else {
        row = db.prepare(`
      SELECT m.conversation_id
      FROM dm_messages m
      WHERE m.id=?
    `).get(msgId);
    }
    if (!row) return null;

    if (HAS_MSG_REACTION_SNAPSHOT) {
        return {
            conversation_id: row.conversation_id,
            reactable: !!row.msg_reactable,
            mode: row.msg_mode || 'both',
        };
    }

    const st = ensureConvSettings(row.conversation_id);
    return {
        conversation_id: row.conversation_id,
        reactable: !!st.reactable && st.reaction_mode !== 'none',
        mode: st.reaction_mode || 'both',
    };
}

/* ====== SSE ====== */
const userStreams = new Map(); // userId -> Set(res)
function getUserStreamSet(userId) {
    let set = userStreams.get(userId);
    if (!set) {
        set = new Set();
        userStreams.set(userId, set);
    }
    return set;
}
function broadcastToUser(userId, event, data, id) {
    const set = userStreams.get(userId);
    if (!set || set.size === 0) return;
    const payload = (id ? `id: ${id}\n` : '') + `event: ${event}\n` + `data: ${JSON.stringify(data || {})}\n\n`;
    for (const res of set) {
        try {
            res.write(payload);
        } catch { }
    }
}
function broadcastToUsersOfConv(convId, event, data, id) {
    try {
        const members = listMemberUsers(convId) || [];
        for (const m of members) broadcastToUser(m.id, event, data, id);
    } catch { }
}
router.get('/dm/stream', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    getUserStreamSet(req.userId).add(res);
    res.write(`event: hello\ndata: {"ok":true}\n\n`);

    req.on('close', () => {
        const set = userStreams.get(req.userId);
        if (set) set.delete(res);
        if (set && set.size === 0) userStreams.delete(req.userId);
    });
});

const streams = new Map(); // convId -> Set(res)
function getStreamSet(convId) {
    let set = streams.get(convId);
    if (!set) {
        set = new Set();
        streams.set(convId, set);
    }
    return set;
}
function broadcast(convId, event, data, id) {
    const set = streams.get(convId);
    if (!set || set.size === 0) return;
    const payload = (id ? `id: ${id}\n` : '') + `event: ${event}\n` + `data: ${JSON.stringify(data || {})}\n\n`;
    for (const res of set) {
        try {
            res.write(payload);
        } catch { }
    }
}
setInterval(() => {
    for (const set of streams.values()) {
        for (const res of set) {
            try {
                res.write(`: ping\n\n`);
            } catch { }
        }
    }
    for (const set of userStreams.values()) {
        for (const res of set) {
            try {
                res.write(`: ping\n\n`);
            } catch { }
        }
    }
}, 15000);

/* ====== multer (1 MB hard limit per file) ====== */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 },
});

/* ====== background cleanup (deleted groups list, 30 days) ====== */
function purgeDeletedGroups() {
    try {
        db.prepare(`DELETE FROM dm_deleted_groups WHERE deleted_at < datetime('now','-30 days')`).run();
    } catch { }
}
setInterval(purgeDeletedGroups, 12 * 60 * 60 * 1000);
purgeDeletedGroups();

/* ====== emoji utils ====== */
function isStreamableMedia(mime) {
    return /^audio\/|^video\//i.test(String(mime || ''));
}
function publicEmojiURL(filename) {
    return `/media/custom-emojis/${encodeURIComponent(path.basename(filename || ''))}`;
}
function normalizeUnicode(u) {
    if (!u) return null;
    return Array.from(u)[0];
}
function makeReactionFromBody(body) {
    const rawKey = String(body?.reaction_key || '').trim();
    if (rawKey) {
        if (/^u:/.test(rawKey)) return { kind: 'emoji', reaction_key: rawKey, unicode: rawKey.slice(2) };
        if (/^c:\d+$/.test(rawKey)) return { kind: 'custom', reaction_key: rawKey, custom_emoji_id: +rawKey.slice(2) };
        throw new Error('bad_reaction_key');
    }
    const kind = body?.kind === 'custom' ? 'custom' : 'emoji';
    if (kind === 'emoji') {
        const unicode = normalizeUnicode(String(body?.unicode || ''));
        if (!unicode) throw new Error('bad_unicode');
        return { kind, reaction_key: `u:${unicode}`, unicode };
    }
    const id = +(body?.custom_emoji_id || 0);
    if (!id) throw new Error('bad_custom_id');
    return { kind, reaction_key: `c:${id}`, custom_emoji_id: id };
}
function pruneRecents(userId) {
    try {
        db.prepare(
            `
      DELETE FROM user_recent_reactions
      WHERE user_id=?
        AND reaction_key NOT IN (
          SELECT reaction_key FROM user_recent_reactions
          WHERE user_id=? ORDER BY last_used_at DESC LIMIT 10
        )
    `
        ).run(userId, userId);
    } catch { }
}

/* ====== routes: custom emojis (unified schema) ====== */

// Upload a new custom emoji, add it to my library (max 100 saved)
router.post('/dm/custom-emojis', requireAuth, uploadEmoji.single('file'), (req, res) => {
    const file = req.file;
    if (!file || !file.buffer?.length) return res.status(400).json({ error: 'no_file' });
    if (!/^image\//i.test(file.mimetype || '')) return res.status(415).json({ error: 'bad_type' });

    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const ext =
        (file.mimetype.split('/')[1] || 'png').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'png';
    const filename = `${hash}.${ext}`;
    const diskPath = path.join(EMOJI_DIR, filename);

    if (!fs.existsSync(diskPath)) {
        try {
            fs.writeFileSync(diskPath, file.buffer);
        } catch {
            return res.status(500).json({ error: 'store_failed' });
        }
    }

    const tx = db.transaction(() => {
        db.prepare(
            `
      INSERT INTO custom_emojis(sha256, filename, mime_type, uploader_id, created_at)
      VALUES(?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(sha256) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type
    `
        ).run(hash, filename, file.mimetype || 'image/png', req.userId);

        const emoji = db
            .prepare(`SELECT id, filename, mime_type FROM custom_emojis WHERE sha256=?`)
            .get(hash);

        const count =
            db.prepare(`SELECT COUNT(*) AS n FROM user_custom_emojis WHERE user_id=?`).get(req.userId)
                ?.n | 0;
        if (count >= 100) throw new Error('limit');

        db.prepare(
            `
      INSERT OR IGNORE INTO user_custom_emojis(user_id, emoji_id, created_at)
      VALUES(?,?,CURRENT_TIMESTAMP)
    `
        ).run(req.userId, emoji.id);

        return emoji;
    });

    try {
        const emoji = tx();
        res.json({
            ok: true,
            id: emoji.id,
            url: publicEmojiURL(emoji.filename),
            mime_type: emoji.mime_type,
        });
    } catch (e) {
        if (String(e.message).includes('limit'))
            return res.status(400).json({ error: 'library_limit_100' });
        return res.status(500).json({ error: 'server_error' });
    }
});

// Bookmark someone else's custom emoji
router.post('/dm/custom-emojis/:id/bookmark', requireAuth, (req, res) => {
    const emojiId = +req.params.id;
    const exists = db.prepare(`SELECT id FROM custom_emojis WHERE id=?`).get(emojiId);
    if (!exists) return res.status(404).json({ error: 'not_found' });

    const count =
        db.prepare(`SELECT COUNT(*) AS n FROM user_custom_emojis WHERE user_id=?`).get(req.userId)?.n |
        0;
    if (count >= 100) return res.status(400).json({ error: 'library_limit_100' });

    db.prepare(
        `
    INSERT OR IGNORE INTO user_custom_emojis(user_id, emoji_id, created_at)
    VALUES(?,?,CURRENT_TIMESTAMP)
  `
    ).run(req.userId, emojiId);

    res.json({ ok: true });
});

// My saved custom emojis
router.get('/dm/custom-emojis/me', requireAuth, (req, res) => {
    const rows = db
        .prepare(
            `
    SELECT e.id, e.filename, e.mime_type
    FROM user_custom_emojis u
    JOIN custom_emojis e ON e.id=u.emoji_id
    WHERE u.user_id=?
    ORDER BY u.created_at DESC
    LIMIT 100
  `
        )
        .all(req.userId);

    res.json({
        ok: true,
        items: rows.map((r) => ({
            id: r.id,
            url: publicEmojiURL(r.filename),
            mime_type: r.mime_type,
        })),
    });
});

/* ====== conversation creation / reuse ====== */

router.post('/dm/with/:slug', requireAuth, (req, res) => {
    const s = String(req.params.slug || '').trim();
    const other = findUserBySlugOrId(s);
    if (!other) return res.status(404).json({ error: 'user_not_found' });
    if (other.id === req.userId) return res.status(400).json({ error: 'self' });

    const row = db
        .prepare(
            `
    SELECT c.id
    FROM dm_conversations c
    JOIN dm_members m1 ON m1.conversation_id=c.id AND m1.user_id=?
    JOIN dm_members m2 ON m2.conversation_id=c.id AND m2.user_id=?
    WHERE c.is_group=0 AND c.deleted_at IS NULL
    LIMIT 1
  `
        )
        .get(req.userId, other.id);

    if (row) {
        ensureConvKey(row.id);
        db.prepare(`DELETE FROM dm_hidden WHERE conversation_id=? AND user_id IN (?,?)`).run(
            row.id,
            req.userId,
            other.id
        );
        return res.json({ ok: true, conversation_id: row.id, id: row.id });
    }

    const tx = db.transaction(() => {
        const r = db
            .prepare(
                `INSERT INTO dm_conversations(is_group, title, owner_id, color) VALUES(0, NULL, NULL, NULL)`
            )
            .run();
        const convId = r.lastInsertRowid;
        db.prepare(`INSERT INTO dm_members(conversation_id, user_id) VALUES(?,?)`).run(convId, req.userId);
        db.prepare(`INSERT INTO dm_members(conversation_id, user_id) VALUES(?,?)`).run(convId, other.id);
        ensureConvKey(convId);
        return convId;
    });
    const id = tx();
    broadcastToUsersOfConv(id, 'conv_new', { id }, String(id));
    res.json({ ok: true, conversation_id: id, id });
});

router.post('/dm/conversations', requireAuth, (req, res) => {
    let { user_ids = [], title = null, color = null } = req.body || {};
    user_ids = Array.from(
        new Set([...(user_ids || []).map((n) => +n).filter(Boolean), req.userId])
    ).sort((a, b) => a - b);
    if (user_ids.length < 2) return res.status(400).json({ error: 'need_two_members' });

    const isGroup = user_ids.length > 2 ? 1 : 0;

    if (!isGroup) {
        const row = db
            .prepare(
                `
      SELECT c.id
      FROM dm_conversations c
      JOIN dm_members m1 ON m1.conversation_id=c.id AND m1.user_id=?
      JOIN dm_members m2 ON m2.conversation_id=c.id AND m2.user_id=?
      WHERE c.is_group=0 AND c.deleted_at IS NULL
      LIMIT 1
    `
            )
            .get(user_ids[0], user_ids[1]);
        if (row) {
            ensureConvKey(row.id);
            db.prepare(`DELETE FROM dm_hidden WHERE conversation_id=? AND user_id=?`).run(row.id, req.userId);
            return res.json({ ok: true, conversation_id: row.id, id: row.id });
        }
    } else {
        if (user_ids.length < 3) return res.status(400).json({ error: 'min_size' });
    }

    const tx = db.transaction(() => {
        const r = db
            .prepare(
                `INSERT INTO dm_conversations(is_group, title, owner_id, color) VALUES(?,?,?,?)`
            )
            .run(isGroup, isGroup ? String(title || 'Group') : null, isGroup ? req.userId : null, isGroup ? color || null : null);

        const convId = r.lastInsertRowid;
        for (const uid of user_ids) {
            db.prepare(`INSERT INTO dm_members(conversation_id, user_id) VALUES(?,?)`).run(convId, uid);
        }
        ensureConvKey(convId);

        if (isGroup) {
            const palette = ['#3b82f6', '#22c55e', '#a855f7', '#f97316', '#ec4899', '#14b8a6', '#eab308', '#ef4444'];
            const used = new Set();
            for (const uid of user_ids) {
                const pick = palette.find((c) => !used.has(c)) || palette[Math.random() * palette.length | 0];
                used.add(pick);
                db.prepare(
                    `INSERT INTO dm_message_colors(conversation_id, user_id, color, updated_at)
           VALUES(?,?,?,CURRENT_TIMESTAMP)
           ON CONFLICT(conversation_id,user_id) DO UPDATE SET color=excluded.color, updated_at=CURRENT_TIMESTAMP`
                ).run(convId, uid, pick);
            }
        }
        return convId;
    });

    const id = tx();
    broadcastToUsersOfConv(id, 'conv_new', { id }, String(id));
    res.json({ ok: true, conversation_id: id, id });
});

/* ====== conversations: list/details/stream ====== */

router.get('/dm/conversations', requireAuth, (req, res) => {
    const rows = db
        .prepare(
            `
    SELECT c.id, c.is_group, c.title, c.color,
           (SELECT body_cipher FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_body_cipher,
           (SELECT body_nonce  FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_body_nonce,
           (SELECT id FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_msg_id
    FROM dm_conversations c
    JOIN dm_members m ON m.conversation_id=c.id
    LEFT JOIN dm_hidden h ON h.conversation_id=c.id AND h.user_id=?
    WHERE m.user_id=? AND (c.deleted_at IS NULL)
      AND (h.last_hidden_msg_id IS NULL OR
           ( (SELECT id FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) > h.last_hidden_msg_id ))
    ORDER BY (last_msg_id IS NULL), last_msg_id DESC
  `
        )
        .all(req.userId, req.userId);

    const out = rows.map((r) => {
        let preview = '';
        try {
            const key = getOrCreateConvKey(r.id);
            if (key && r.last_body_cipher && r.last_body_nonce) {
                const body = decryptJSON(key, r.last_body_cipher, r.last_body_nonce);
                preview = (body?.text || '').slice(0, 80);
            }
        } catch { }
        return { id: r.id, is_group: !!r.is_group, title: r.title, color: r.color || null, preview };
    });
    res.json({ ok: true, items: out });
});

router.get('/dm/conversations/:id', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const conv = getConv(convId);
    if (!conv) return res.status(404).json({ error: 'not_found' });
    if (conv.deleted_at) return res.status(410).json({ error: 'gone' });
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const members = db
        .prepare(
            `
    SELECT u.id, u.username, u.first_username, u.profile_photo
    FROM dm_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id=?
    ORDER BY u.id
  `
        )
        .all(convId);

    const other = !conv.is_group ? members.find((u) => (u.id | 0) !== (req.userId | 0)) || null : null;

    const icon = db.prepare(`SELECT updated_at FROM dm_group_icons WHERE conversation_id=?`).get(convId);
    const photo = icon ? `/api/dm/conversations/${convId}/icon?ts=${encodeURIComponent(icon.updated_at)}` : null;

    res.json({
        ok: true,
        id: conv.id,
        is_group: !!conv.is_group,
        title: conv.title,
        owner_id: conv.owner_id || null,
        is_owner: !!(conv.owner_id && (conv.owner_id | 0) === (req.userId | 0)),
        color: conv.color || null,
        photo,
        members,
        other,
    });
});

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

/* ====== settings ====== */

router.get('/dm/conversations/:id/settings', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });
    const st = ensureConvSettings(convId);
    res.json({ ok: true, settings: st });
});

router.patch('/dm/conversations/:id/settings', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const conv = getConv(convId);
    if (!conv) return res.status(404).json({ error: 'not_found' });
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    // Only owners in groups; in 1:1 either participant may change
    if (conv.is_group && (conv.owner_id | 0) !== (req.userId | 0)) {
        return res.status(403).json({ error: 'owner_only' });
    }

    const st = ensureConvSettings(convId);
    const allow_delete =
        req.body?.allow_delete === undefined ? st.allow_delete : !!req.body.allow_delete ? 1 : 0;
    const delete_window_sec =
        req.body?.delete_window_sec === undefined || req.body.delete_window_sec === '' || req.body.delete_window_sec === null
            ? st.delete_window_sec
            : isNaN(+req.body.delete_window_sec)
                ? null
                : Math.max(0, +req.body.delete_window_sec | 0);

    const reactable = req.body?.reactable === undefined ? st.reactable : !!req.body.reactable ? 1 : 0;
    const reaction_mode_raw = (req.body?.reaction_mode || st.reaction_mode || 'both').toString().toLowerCase();
    const reaction_mode = ['none', 'emoji', 'custom', 'both'].includes(reaction_mode_raw)
        ? reaction_mode_raw
        : 'both';

    db.prepare(
        `
    UPDATE dm_settings
    SET allow_delete=?,
        delete_window_sec=?,
        reactable=?,
        reaction_mode=?,
        receipts_enabled=1,
        updated_at=CURRENT_TIMESTAMP
    WHERE conversation_id=?
  `
    ).run(allow_delete, delete_window_sec, reactable, reaction_mode, convId);

    const updated = db.prepare(`SELECT * FROM dm_settings WHERE conversation_id=?`).get(convId);
    broadcastToUsersOfConv(convId, 'conv_settings', { conversation_id: convId, settings: updated });
    res.json({ ok: true, settings: updated });
});

/* ====== messages ====== */

// List (ASC). Supports ?before= and ?after=; can include reactions via ?with=reactions
router.get('/dm/conversations/:id/messages', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
    const before = parseInt(req.query.before || '0', 10) || 0;
    const after = parseInt(req.query.after || '0', 10) || 0;

    let rows = [];
    const baseCols = `
    id, sender_id, kind, body_cipher, body_nonce, created_at
    ${HAS_MSG_REACTION_SNAPSHOT ? ', reactable AS reactable_at_send, reaction_mode_at_send' : ''}
    ${HAS_MSG_DELETE_SNAPSHOT ? ', deletable_at_send, delete_window_sec_at_send' : ''}
  `;

    if (after > 0) {
        rows = db
            .prepare(
                `
      SELECT ${baseCols}
      FROM dm_messages
      WHERE conversation_id=? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `
            )
            .all(convId, after, limit);
    } else if (before > 0) {
        const r = db
            .prepare(
                `
      SELECT ${baseCols}
      FROM dm_messages
      WHERE conversation_id=? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `
            )
            .all(convId, before, limit);
        rows = r.reverse();
    } else {
        const r = db
            .prepare(
                `
      SELECT ${baseCols}
      FROM dm_messages
      WHERE conversation_id=?
      ORDER BY id DESC
      LIMIT ?
    `
            )
            .all(convId, limit);
        rows = r.reverse();
    }

    const key = getOrCreateConvKey(convId);
    const attCols = hasDurationCol()
        ? `id, filename, mime_type, encoding, size_bytes, duration_ms`
        : `id, filename, mime_type, encoding, size_bytes, NULL AS duration_ms`;

    // Get current settings for fallback snapshot computation if needed
    const st = HAS_MSG_DELETE_SNAPSHOT && HAS_MSG_REACTION_SNAPSHOT ? null : ensureConvSettings(convId);

    const msgs = rows.map((r) => {
        let text = '';
        try {
            if (key && r.body_cipher && r.body_nonce) {
                const obj = decryptJSON(key, r.body_cipher, r.body_nonce);
                text = obj?.text || '';
            }
        } catch { }
        const atts = db
            .prepare(
                `
      SELECT ${attCols}
      FROM dm_attachments WHERE message_id=? ORDER BY id ASC
    `
            )
            .all(r.id);

        // Per-message policy fields (snapshots). If snapshot cols missing, synthesize from conv settings.
        const reactable_at_send = HAS_MSG_REACTION_SNAPSHOT
            ? !!r.reactable_at_send
            : !!st.reactable && st.reaction_mode !== 'none';
        const reaction_mode_at_send = HAS_MSG_REACTION_SNAPSHOT ? r.reaction_mode_at_send || 'both' : st.reaction_mode || 'both';
        const deletable_at_send = HAS_MSG_DELETE_SNAPSHOT ? !!r.deletable_at_send : !!st.allow_delete;
        const delete_window_sec_at_send = HAS_MSG_DELETE_SNAPSHOT ? r.delete_window_sec_at_send : st.delete_window_sec;

        return {
            id: r.id,
            sender_id: r.sender_id,
            kind: r.kind,
            text,
            attachments: atts,
            created_at: r.created_at,
            reactable_at_send,
            reaction_mode_at_send,
            deletable_at_send,
            delete_window_sec_at_send,
        };
    });

    // Optional reactions enrichment
    if (String(req.query.with || '').includes('reactions')) {
        const ids = msgs.map((m) => m.id);
        if (ids.length) {
            const all = db
                .prepare(
                    `
        SELECT message_id, reaction_key, kind, unicode, custom_emoji_id, user_id
        FROM dm_message_reactions
        WHERE message_id IN (${ids.map(() => '?').join(',')})
      `
                )
                .all(...ids);
            const map = new Map();
            for (const m of msgs) map.set(m.id, []);
            for (const mid of ids) {
                const rows = all.filter((r) => r.message_id === mid);
                const keyed = new Map();
                for (const r of rows) {
                    const k = `${r.reaction_key}|${r.custom_emoji_id || 0}|${r.unicode || ''}`;
                    if (!keyed.has(k)) {
                        keyed.set(k, {
                            reaction_key: r.reaction_key,
                            kind: r.kind,
                            unicode: r.unicode || null,
                            custom_emoji_id: r.custom_emoji_id || null,
                            user_ids: [],
                        });
                    }
                    keyed.get(k).user_ids.push(r.user_id);
                }
                const stacks = Array.from(keyed.values()).map((s) => ({ ...s, count: s.user_ids.length }));
                map.set(mid, stacks);
            }
            for (const m of msgs) m.reactions = map.get(m.id) || [];
        }
    }

    const next_before = msgs.length ? msgs[0].id : null;
    res.json({ ok: true, items: msgs, next_before });
});

// Send a message — snapshot per-message delete & reaction policy at send time
router.post('/dm/conversations/:id/messages', requireAuth, upload.array('files', 8), async (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const text = String(req.body?.text || '');
    const files = req.files || [];
    if (!text && files.length === 0) return res.status(400).json({ error: 'empty' });

    const key = getOrCreateConvKey(convId);
    if (!key) return res.status(500).json({ error: 'key_missing' });

    const kind = files.length ? (text ? 'mix' : 'file') : (req.body?.kind || 'text');
    const encBody = encryptJSON(key, { text });

    const st = ensureConvSettings(convId) || {};
    const snapReactable = !!st.reactable && st.reaction_mode !== 'none' ? 1 : 0;
    const snapMode = st.reaction_mode || 'both';
    const snapDeletable = !!st.allow_delete ? 1 : 0;
    const snapDeleteWindow = st.delete_window_sec == null ? null : Math.max(0, +st.delete_window_sec | 0);

    // Precompute audio durations
    const preDurations = new Map();
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const declaredEnc = (f?.encoding || req.body?.[`encoding_${f.originalname}`] || req.body?.encoding || '').toLowerCase();
        const isAudio = (f?.mimetype || '').toLowerCase().startsWith('audio/');
        if (isAudio && f?.buffer?.length) {
            try {
                const ms = await probeAudioDurationMsFromBuffer(
                    f.buffer,
                    f.mimetype,
                    declaredEnc === 'gzip' ? 'gzip' : null
                );
                if (ms && Number.isFinite(ms)) preDurations.set(i, ms);
            } catch { }
        }
    }

    const useDur = hasDurationCol();
    const insertWithDuration = useDur
        ? db.prepare(
            `
    INSERT INTO dm_attachments(message_id, filename, mime_type, encoding, size_bytes, duration_ms, blob_cipher, blob_nonce)
    VALUES(?,?,?,?,?,?,?,?)
    `
        )
        : null;
    const insertWithoutDuration = db.prepare(
        `
    INSERT INTO dm_attachments(message_id, filename, mime_type, encoding, size_bytes, blob_cipher, blob_nonce)
    VALUES(?,?,?,?,?,?,?)
    `
    );

    const tx = db.transaction(() => {
        const msgId = db
            .prepare(
                `
      INSERT INTO dm_messages(conversation_id, sender_id, kind, body_cipher, body_nonce)
      VALUES(?,?,?,?,?)
    `
            )
            .run(convId, req.userId, kind, encBody.cipher, encBody.nonce).lastInsertRowid;

        // Snapshot per-message policy (only set cols that exist)
        if (HAS_MSG_REACTION_SNAPSHOT && HAS_MSG_DELETE_SNAPSHOT) {
            db.prepare(
                `UPDATE dm_messages
         SET reactable=?, reaction_mode_at_send=?, deletable_at_send=?, delete_window_sec_at_send=?
         WHERE id=?`
            ).run(snapReactable, snapMode, snapDeletable, snapDeleteWindow, msgId);
        } else if (HAS_MSG_REACTION_SNAPSHOT) {
            db.prepare(
                `UPDATE dm_messages
         SET reactable=?, reaction_mode_at_send=?
         WHERE id=?`
            ).run(snapReactable, snapMode, msgId);
        } else if (HAS_MSG_DELETE_SNAPSHOT) {
            db.prepare(
                `UPDATE dm_messages
         SET deletable_at_send=?, delete_window_sec_at_send=?
         WHERE id=?`
            ).run(snapDeletable, snapDeleteWindow, msgId);
        }

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const encoding =
                (f?.encoding || req.body?.[`encoding_${f.originalname}`] || req.body?.encoding || '').toLowerCase() ===
                    'gzip'
                    ? 'gzip'
                    : null;
            const metaMime = f.mimetype || 'application/octet-stream';
            const metaName = f.originalname || 'file';
            const enc = aeadEncrypt(key, f.buffer);
            const dur = preDurations.get(i) ?? null;

            if (useDur) {
                insertWithDuration.run(
                    msgId,
                    metaName,
                    metaMime,
                    encoding,
                    f.size | 0,
                    dur ?? null,
                    enc.cipher,
                    enc.nonce
                );
            } else {
                const attId = insertWithoutDuration.run(
                    msgId,
                    metaName,
                    metaMime,
                    encoding,
                    f.size | 0,
                    enc.cipher,
                    enc.nonce
                ).lastInsertRowid;
                if (dur != null) {
                    try {
                        db.prepare(`UPDATE dm_attachments SET duration_ms=? WHERE id=?`).run(dur, attId);
                    } catch { }
                }
            }
        }
        return msgId;
    });

    const id = tx();
    broadcast(convId, 'new', { id }, String(id));
    broadcastToUsersOfConv(convId, 'message', { conversation_id: convId, id }, String(id));
    res.json({ ok: true, id });
});

// Delete a message (author-only, per-message snapshot policy)
router.delete('/dm/messages/:id', requireAuth, (req, res) => {
    const msgId = +req.params.id;
    const row = db
        .prepare(
            `
    SELECT m.id, m.conversation_id, m.sender_id, m.created_at
           ${HAS_MSG_DELETE_SNAPSHOT ? ', m.deletable_at_send, m.delete_window_sec_at_send' : ''}
    FROM dm_messages m WHERE m.id=?
  `
        )
        .get(msgId);

    if (!row) return res.status(404).json({ error: 'not_found' });
    if (!isMember(row.conversation_id, req.userId)) return res.status(403).json({ error: 'forbidden' });

    if (!canDeleteMessageForUser(row, req.userId)) {
        return res.status(403).json({ error: 'not_deletable' });
    }

    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM dm_message_reactions WHERE message_id=?`).run(msgId);
        db.prepare(`DELETE FROM dm_messages WHERE id=? AND sender_id=?`).run(msgId, req.userId);
    });
    tx();

    broadcast(row.conversation_id, 'message_deleted', { id: msgId }, String(msgId));
    broadcastToUsersOfConv(
        row.conversation_id,
        'message_deleted',
        { conversation_id: row.conversation_id, id: msgId },
        String(msgId)
    );
    res.json({ ok: true });
});

/* ====== members mgmt ====== */

router.get('/dm/conversations/:id/members', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const members = db
        .prepare(
            `
    SELECT u.id, u.username, u.first_username, u.profile_photo
    FROM dm_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id=?
    ORDER BY u.id
  `
        )
        .all(convId);

    res.json({ ok: true, members });
});

router.patch('/dm/conversations/:id/members', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : error === 'deleted' ? 410 : 404).json({ error });
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });
    if ((conv.owner_id | 0) !== (req.userId | 0)) return res.status(403).json({ error: 'owner_only' });

    let { add_user_ids = [], remove_user_ids = [] } = req.body || {};
    const adds = Array.from(new Set((add_user_ids || []).map((n) => +n).filter(Boolean)));
    const rems = Array.from(
        new Set((remove_user_ids || []).map((n) => +n).filter((uid) => uid !== conv.owner_id))
    );

    for (const uid of adds) {
        if (!areFriends(conv.owner_id, uid))
            return res.status(400).json({ error: 'not_friends', user_id: uid });
        const blocked = db
            .prepare(`SELECT 1 FROM dm_conv_blocks WHERE conversation_id=? AND user_id=?`)
            .get(convId, uid);
        if (blocked) return res.status(400).json({ error: 'user_blocked', user_id: uid });
    }

    const current = db
        .prepare(`SELECT user_id FROM dm_members WHERE conversation_id=? ORDER BY user_id`)
        .all(convId)
        .map((r) => r.user_id);
    const currentSet = new Set(current);

    const tx = db.transaction(() => {
        for (const uid of rems) {
            if (currentSet.has(uid)) {
                db.prepare(`DELETE FROM dm_members WHERE conversation_id=? AND user_id=?`).run(convId, uid);
                db.prepare(`DELETE FROM dm_message_colors WHERE conversation_id=? AND user_id=?`).run(convId, uid);
            }
        }
        for (const uid of adds) {
            if (!currentSet.has(uid)) {
                db.prepare(`INSERT OR IGNORE INTO dm_members(conversation_id, user_id) VALUES(?,?)`).run(convId, uid);
            }
        }
    });
    tx();

    const remaining = memberCount(convId);
    if (remaining <= 0) softDeleteGroup(convId);

    res.json({ ok: true, remaining, deleted: remaining <= 0 });
});

router.patch('/dm/conversations/:id/title', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : error === 'deleted' ? 410 : 404).json({ error });
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });
    if ((conv.owner_id | 0) !== (req.userId | 0)) return res.status(403).json({ error: 'owner_only' });

    const raw = String(req.body?.title || '').trim();
    if (!raw) return res.status(400).json({ error: 'empty_title' });
    const title = raw.slice(0, 120);

    const tx = db.transaction(() => {
        db.prepare(`UPDATE dm_conversations SET title=? WHERE id=?`).run(title, convId);
        const actorName = getUserLabel(req.userId);
        addSystemMessage(convId, req.userId, `${actorName} changed the group name to ${title}`);
    });
    tx();

    res.json({ ok: true });
});

router.patch('/dm/conversations/:id/owner', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : error === 'deleted' ? 410 : 404).json({ error });
    if ((conv.owner_id | 0) !== (req.userId | 0)) return res.status(403).json({ error: 'owner_only' });

    const newOwnerId = +req.body?.owner_id;
    if (!newOwnerId || !isMember(convId, newOwnerId)) return res.status(400).json({ error: 'bad_owner' });

    const tx = db.transaction(() => {
        db.prepare(`UPDATE dm_conversations SET owner_id=? WHERE id=?`).run(newOwnerId, convId);
        const oldName = getUserLabel(req.userId);
        const newName = getUserLabel(newOwnerId);
        addSystemMessage(convId, req.userId, `${oldName} made ${newName} the group owner.`);
    });
    tx();

    res.json({ ok: true });
});

router.post('/dm/conversations/:id/leave', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : error === 'deleted' ? 410 : 404).json({ error });
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const tx = db.transaction(() => {
        db.prepare(`DELETE FROM dm_members WHERE conversation_id=? AND user_id=?`).run(convId, req.userId);
        db.prepare(`DELETE FROM dm_message_colors WHERE conversation_id=? AND user_id=?`).run(convId, req.userId);
        addSystemMessage(convId, req.userId, `${getUserLabel(req.userId)} left the group.`);
    });
    tx();

    const remaining = memberCount(convId);
    if (remaining <= 0) softDeleteGroup(convId);

    res.json({ ok: true, remaining, deleted: remaining <= 0 });
});

router.post('/dm/conversations/:id/disband', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : error === 'deleted' ? 410 : 404).json({ error });
    if ((conv.owner_id | 0) !== (req.userId | 0)) return res.status(403).json({ error: 'owner_only' });

    const tx = db.transaction(() => {
        db.prepare(`UPDATE dm_conversations SET deleted_at = CURRENT_TIMESTAMP WHERE id=?`).run(convId);
        db.prepare(`INSERT INTO dm_deleted_groups(conversation_id, deleted_at) VALUES(?, CURRENT_TIMESTAMP)`).run(
            convId
        );
        db.prepare(`DELETE FROM dm_conversations WHERE id=?`).run(convId);
    });
    tx();

    res.json({ ok: true });
});

router.post('/dm/conversations/:id/delete_for_me', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const lastMsg = db
        .prepare(`SELECT id FROM dm_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1`)
        .get(convId);
    const lastId = lastMsg?.id || 0;

    db.prepare(
        `
    INSERT INTO dm_hidden(user_id, conversation_id, last_hidden_msg_id)
    VALUES(?,?,?)
    ON CONFLICT(user_id,conversation_id) DO UPDATE SET last_hidden_msg_id=excluded.last_hidden_msg_id
  `
    ).run(req.userId, convId, lastId);

    res.json({ ok: true });
});

router.post('/dm/conversations/:id/block', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const conv = getConv(convId);
    if (!conv) return res.status(404).json({ error: 'not_found' });

    db.prepare(
        `INSERT OR IGNORE INTO dm_conv_blocks(user_id, conversation_id, created_at) VALUES(?,?,CURRENT_TIMESTAMP)`
    ).run(req.userId, convId);

    if (isMember(convId, req.userId) && conv.is_group) {
        db.prepare(`DELETE FROM dm_members WHERE conversation_id=? AND user_id=?`).run(convId, req.userId);
        db.prepare(`DELETE FROM dm_message_colors WHERE conversation_id=? AND user_id=?`).run(convId, req.userId);
        addSystemMessage(convId, req.userId, `${getUserLabel(req.userId)} left the group.`);
    }

    res.json({ ok: true });
});

/* ====== seen receipts (per-conversation) ====== */

function upsertReadState(convId, userId, lastReadMsgId) {
    db.prepare(`
    INSERT INTO dm_read_states
      (conversation_id, user_id, last_received_msg_id, last_read_msg_id, updated_at)
    VALUES
      (?, ?, 0, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(conversation_id, user_id) DO UPDATE SET
      last_read_msg_id = MAX(dm_read_states.last_read_msg_id, excluded.last_read_msg_id),
      updated_at = CURRENT_TIMESTAMP
  `).run(convId, userId, lastReadMsgId | 0);
}

router.post('/dm/conversations/:id/seen', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const lastSeen = Math.max(0, +req.body?.last_seen_msg_id || 0);
    if (!lastSeen) return res.status(400).json({ error: 'bad_last_id' });

    upsertReadState(convId, req.userId, lastSeen);
    broadcast(convId, 'receipt', {
        conversation_id: convId,
        user_id: req.userId,
        last_seen_msg_id: lastSeen,
    });

    res.json({ ok: true });
});

router.get('/dm/conversations/:id/seen', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const latest = db
        .prepare(`SELECT id FROM dm_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1`)
        .get(convId);
    const latestId = latest?.id || 0;

    const seenRows = db.prepare(`
      SELECT s.user_id, u.profile_photo
      FROM dm_read_states s
      JOIN users u ON u.id = s.user_id
      WHERE s.conversation_id = ? AND s.last_read_msg_id >= ?
      ORDER BY s.updated_at DESC
    `).all(convId, latestId);

    const mine = db
        .prepare(`SELECT last_read_msg_id FROM dm_read_states WHERE conversation_id=? AND user_id=?`)
        .get(convId, req.userId);

    res.json({
        ok: true,
        latest_msg_id: latestId,
        seen_by: seenRows,
        my_last_seen_msg_id: mine?.last_read_msg_id || 0,
    });
});
// --- helpers for reactions ---
function parseReactionKey(key) {
    if (!key || typeof key !== 'string') return null;
    if (key.startsWith('u:')) {
        const unicode = key.slice(2);
        if (!unicode) return null;
        return { kind: 'emoji', reaction_key: `u:${unicode}`, unicode, custom_emoji_id: null };
    }
    if (key.startsWith('c:')) {
        const id = +key.slice(2);
        if (!Number.isFinite(id) || id <= 0) return null;
        return { kind: 'custom', reaction_key: `c:${id}`, unicode: null, custom_emoji_id: id };
    }
    return null;
}

function reactionsAllowedFor(msg, settings, rxKind) {
    // settings defaults from schema: reactable=1, reaction_mode='both'
    const on = !!(settings?.reactable ?? 1);
    const mode = settings?.reaction_mode || 'both';
    if (!on || mode === 'none') return false;

    // effective_from gates only *newer* messages
    if (settings?.reactions_effective_from) {
        const msgMs = new Date(msg.created_at).getTime();
        const effMs = new Date(settings.reactions_effective_from).getTime();
        if (Number.isFinite(msgMs) && Number.isFinite(effMs) && msgMs < effMs) return false;
    }
    if (mode === 'emoji' && rxKind !== 'emoji') return false;
    if (mode === 'custom' && rxKind !== 'custom') return false;
    return true;
}

// ====== Reactions: toggle ======
router.post('/dm/messages/:id/reactions/toggle', requireAuth, (req, res) => {
    try {
        const msgId = +req.params.id;
        const body = req.body || {};
        const parsed = parseReactionKey(body.reaction_key);
        if (!msgId || !parsed) return res.status(400).json({ error: 'bad_request' });

        // message + membership
        const msg = db.prepare(`
    SELECT m.id, m.conversation_id, m.created_at
    FROM dm_messages m
    JOIN dm_members mm
      ON mm.conversation_id = m.conversation_id AND mm.user_id = ?
    WHERE m.id = ?
  `).get(req.userId, msgId);
        if (!msg) return res.status(404).json({ error: 'not_found_or_forbidden' });

        // convo settings
        const st = db.prepare(`
    SELECT reactable, reaction_mode, reactions_effective_from
    FROM dm_settings WHERE conversation_id = ?
  `).get(msg.conversation_id) || {};

        if (!reactionsAllowedFor(msg, st, parsed.kind)) {
            return res.status(403).json({ error: 'reactions_disabled' });
        }

        // toggle
        const exists = db.prepare(`
    SELECT 1 FROM dm_message_reactions
    WHERE message_id=? AND user_id=? AND reaction_key=?
  `).get(msgId, req.userId, parsed.reaction_key);

        if (exists) {
            db.prepare(`
      DELETE FROM dm_message_reactions
      WHERE message_id=? AND user_id=? AND reaction_key=?
    `).run(msgId, req.userId, parsed.reaction_key);
            const count = db.prepare(`
      SELECT COUNT(*) AS c FROM dm_message_reactions
      WHERE message_id=? AND reaction_key=?
    `).get(msgId, parsed.reaction_key)?.c || 0;

            try {
                broadcast(msg.conversation_id, 'reaction', {
                    message_id: msgId, user_id: req.userId, reaction_key: parsed.reaction_key,
                    on: false, count
                });
            } catch { }

            return res.json({ ok: true, toggled: 'off', message_id: msgId, reaction_key: parsed.reaction_key, count });
        }

        // insert (must include NOT NULL "kind")
        db.prepare(`
    INSERT INTO dm_message_reactions
      (message_id, user_id, kind, reaction_key, unicode, custom_emoji_id, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(msgId, req.userId, parsed.kind, parsed.reaction_key, parsed.unicode, parsed.custom_emoji_id);

        // bump recent reactions
        db.prepare(`
    INSERT INTO user_recent_reactions (user_id, reaction_key, last_used_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, reaction_key) DO UPDATE SET last_used_at = CURRENT_TIMESTAMP
  `).run(req.userId, parsed.reaction_key);

        const count = db.prepare(`
    SELECT COUNT(*) AS c FROM dm_message_reactions
    WHERE message_id=? AND reaction_key=?
  `).get(msgId, parsed.reaction_key)?.c || 0;

        try {
            broadcast(msg.conversation_id, 'reaction', {
                message_id: msgId, user_id: req.userId, reaction_key: parsed.reaction_key,
                on: true, count, kind: parsed.kind, unicode: parsed.unicode, custom_emoji_id: parsed.custom_emoji_id
            });
        } catch { }

        return res.json({ ok: true, toggled: 'on', message_id: msgId, reaction_key: parsed.reaction_key, count });
    } catch (e) {
        console.error('[rx][toggle] error', e);
        return res.status(500).json({ error: 'server_error' });
    }
});

/* ====== attachments (seek/range; never gzip audio/video on the wire) ====== */

router.get('/dm/attachments/:id/download', requireAuth, async (req, res) => {
    const row = db
        .prepare(
            `SELECT a.*, m.conversation_id
       FROM dm_attachments a JOIN dm_messages m ON m.id=a.message_id
       WHERE a.id=?`
        )
        .get(+req.params.id);
    if (!row) return res.status(404).end();
    if (!isMember(row.conversation_id, req.userId)) return res.status(403).end();

    const key = getOrCreateConvKey(row.conversation_id);
    if (!key) return res.status(500).json({ error: 'key_missing' });

    let buf;
    try {
        buf = aeadDecrypt(key, row.blob_cipher, row.blob_nonce);
    } catch {
        return res.status(500).json({ error: 'decrypt_failed' });
    }

    const mime = row.mime_type || 'application/octet-stream';
    const media = isStreamableMedia(mime);

    if (media && String(row.encoding || '').toLowerCase() === 'gzip') {
        try {
            buf = await gunzip(buf);
        } catch {
            return res.status(415).json({ error: 'bad_media_compression' });
        }
    }

    const dispKind = String(req.query.inline || '') === '1' ? 'inline' : 'attachment';
    const filename = row.filename || 'attachment';

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `${dispKind}; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control', 'private, no-transform');

    const isGz = String(row.encoding || '').toLowerCase() === 'gzip';
    if (!media && isGz) res.setHeader('Content-Encoding', 'gzip');
    else res.removeHeader('Content-Encoding');

    const outBuf = buf;
    const size = outBuf.length;
    const range = req.headers.range;

    if (!range) {
        res.setHeader('Content-Length', size);
        return res.end(outBuf);
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.status(416).end();
    }

    let start = m[1] === '' ? 0 : parseInt(m[1], 10);
    let end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end)) end = size - 1;
    start = Math.max(0, Math.min(start, size - 1));
    end = Math.max(start, Math.min(end, size - 1));

    const chunk = outBuf.slice(start, end + 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', chunk.length);
    return res.end(chunk);
});

router.get('/dm/attachments/:id/meta', requireAuth, (req, res) => {
    const row = db
        .prepare(
            `SELECT a.duration_ms, m.conversation_id
       FROM dm_attachments a JOIN dm_messages m ON m.id=a.message_id
       WHERE a.id=?`
        )
        .get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (!isMember(row.conversation_id, req.userId)) return res.status(403).end();
    res.json({ duration_ms: Number.isFinite(row.duration_ms) ? row.duration_ms : null });
});

/* ====== message color endpoints ====== */

router.get('/dm/conversations/:id/message_colors', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });
    try {
        const rows = db
            .prepare(`SELECT user_id, color FROM dm_message_colors WHERE conversation_id=?`)
            .all(convId);
        const colors = {};
        for (const r of rows) if (r.color) colors[r.user_id] = r.color;
        res.json({ ok: true, colors });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

router.patch('/dm/conversations/:id/message_colors/me', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const raw = req.body?.color;
    const clear = raw == null || raw === '' || raw === false;
    const color = clear ? null : String(raw).trim();
    if (!clear && !(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)))
        return res.status(400).json({ error: 'bad_color' });

    try {
        if (!color) {
            db.prepare(`DELETE FROM dm_message_colors WHERE conversation_id=? AND user_id=?`).run(convId, req.userId);
        } else {
            db.prepare(
                `
        INSERT INTO dm_message_colors(conversation_id, user_id, color, updated_at)
        VALUES(?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(conversation_id,user_id)
        DO UPDATE SET color=excluded.color, updated_at=CURRENT_TIMESTAMP
      `
            ).run(convId, req.userId, color);
        }
        addSystemMessage(
            convId,
            req.userId,
            clear
                ? `${getUserLabel(req.userId)} cleared their message color.`
                : `${getUserLabel(req.userId)} changed their message color.`
        );
        broadcastToUsersOfConv(convId, 'color_change', { conversation_id: convId, user_id: req.userId, color });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

router.patch('/dm/conversations/:id/message_colors', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : error === 'deleted' ? 410 : 404).json({ error });
    if ((conv.owner_id | 0) !== (req.userId | 0)) return res.status(403).json({ error: 'owner_only' });

    const colors = req.body?.colors || {};
    try {
        for (const [k, v] of Object.entries(colors)) {
            const uid = +k;
            if (!uid || !isMember(convId, uid)) continue;
            if (v == null || v === '') {
                db.prepare(`DELETE FROM dm_message_colors WHERE conversation_id=? AND user_id=?`).run(convId, uid);
                broadcastToUsersOfConv(convId, 'color_change', { conversation_id: convId, user_id: uid, color: null });
                continue;
            }
            const col = String(v).trim();
            if (!/^#[0-9a-f]{6}$/i.test(col)) return res.status(400).json({ error: 'bad_color', user_id: uid });
            db.prepare(
                `
        INSERT INTO dm_message_colors(conversation_id, user_id, color, updated_at)
        VALUES(?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(conversation_id,user_id)
        DO UPDATE SET color=excluded.color, updated_at=CURRENT_TIMESTAMP
      `
            ).run(convId, uid, col);
            broadcastToUsersOfConv(convId, 'color_change', { conversation_id: convId, user_id: uid, color: col });
        }
        addSystemMessage(convId, req.userId, `${getUserLabel(req.userId)} updated message colors.`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

/* ====== appearance (owner only) ====== */

router.patch(
    '/dm/conversations/:id/appearance',
    requireAuth,
    multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } }).single('icon'),
    (req, res) => {
        const convId = +req.params.id;
        const { conv, error } = ensureActiveGroup(convId);
        if (error) return res.status(error === 'not_group' ? 400 : error === 'deleted' ? 410 : 404).json({ error });
        if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });
        if ((conv.owner_id | 0) !== (req.userId | 0)) return res.status(403).json({ error: 'owner_only' });

        const color = typeof req.body?.color === 'string' ? req.body.color.trim() : null;
        const useDefault = String(req.body?.use_default_icon || '') === '1';
        const file = req.file || null;

        const okColor = !color || /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color);
        if (!okColor) return res.status(400).json({ error: 'bad_color' });

        try {
            let didColor = false,
                didIconNew = false,
                didIconDefault = false;

            if (color) {
                db.prepare(`UPDATE dm_conversations SET color=? WHERE id=?`).run(color, convId);
                didColor = true;
            }
            if (useDefault) {
                db.prepare(`DELETE FROM dm_group_icons WHERE conversation_id=?`).run(convId);
                didIconDefault = true;
            } else if (file && file.buffer && file.size > 0) {
                const type = (file.mimetype || 'image/png').toLowerCase();
                if (!/^image\//.test(type)) return res.status(400).json({ error: 'bad_icon_type' });
                const key = getOrCreateConvKey(convId);
                if (!key) return res.status(500).json({ error: 'key_missing' });
                const enc = aeadEncrypt(key, file.buffer);
                db.prepare(
                    `
          INSERT INTO dm_group_icons(conversation_id, mime_type, blob_cipher, blob_nonce, updated_at)
          VALUES(?,?,?,?,CURRENT_TIMESTAMP)
          ON CONFLICT(conversation_id) DO UPDATE
            SET mime_type=excluded.mime_type,
                blob_cipher=excluded.blob_cipher,
                blob_nonce=excluded.blob_nonce,
                updated_at=CURRENT_TIMESTAMP
        `
                ).run(convId, type, enc.cipher, enc.nonce);
                didIconNew = true;
            }

            const actor = getUserLabel(req.userId);
            if (didColor) addSystemMessage(convId, req.userId, `${actor} changed the group color.`);
            if (didIconNew) addSystemMessage(convId, req.userId, `${actor} updated the group icon.`);
            if (didIconDefault) addSystemMessage(convId, req.userId, `${actor} reset the group icon to default.`);

            const icon = db.prepare(`SELECT updated_at FROM dm_group_icons WHERE conversation_id=?`).get(convId);
            const payload = { conversation_id: convId, color: color || null, photo_ts: icon?.updated_at || null };
            broadcastToUsersOfConv(convId, 'conv_meta', payload);

            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
        }
    }
);

router.get('/dm/conversations/:id/icon', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).end();
    const row = db
        .prepare(`SELECT mime_type, blob_cipher, blob_nonce FROM dm_group_icons WHERE conversation_id=?`)
        .get(convId);
    if (!row) return res.status(404).end();

    const key = getOrCreateConvKey(convId);
    if (!key) return res.status(500).json({ error: 'key_missing' });

    try {
        const plain = aeadDecrypt(key, row.blob_cipher, row.blob_nonce);
        res.setHeader('Content-Type', row.mime_type || 'image/png');
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.end(plain);
    } catch (e) {
        res.status(500).json({ error: 'decrypt_failed' });
    }
});

/* ====== friend-unfriend hook ====== */
function removeUserFromOwnerGroups(ownerId, removedUserId) {
    const groups = db
        .prepare(
            `
    SELECT c.id
    FROM dm_conversations c
    JOIN dm_members m ON m.conversation_id=c.id AND m.user_id=?
    WHERE c.is_group=1 AND c.owner_id=? AND c.deleted_at IS NULL
  `
        )
        .all(removedUserId, ownerId);

    const ownerName = getUserLabel(ownerId);
    const removedName = getUserLabel(removedUserId);

    const tx = db.transaction(() => {
        for (const g of groups) {
            const convId = g.id;
            if (!isMember(convId, removedUserId)) continue;
            db.prepare(`DELETE FROM dm_members WHERE conversation_id=? AND user_id=?`).run(convId, removedUserId);
            addSystemMessage(
                convId,
                ownerId,
                `${ownerName} unfriended ${removedName}. They've been removed from the group.`
            );
        }
    });
    tx();

    return { ok: true, count: groups.length };
}

/* ====== reactions (unified on dm_message_reactions) ====== */

function rxDbg(tag, ctx = {}) {
    // trim noisy headers/body for readability
    const clean = (o) => {
        try {
            return JSON.parse(JSON.stringify(o, (k, v) => (
                k === 'cookie' ? '[redacted]' :
                    k === 'authorization' ? '[redacted]' :
                        v
            )));
        } catch { return o; }
    };
    console.log(`[rx][${new Date().toISOString()}] ${tag}`, clean(ctx));
}

function safeUpsertRecentReaction(db, userId, reactionKey) {
    // Works on old SQLite too (no UPSERT needed)
    const upd = db.prepare(
        `UPDATE user_recent_reactions SET last_used_at=CURRENT_TIMESTAMP
     WHERE user_id=? AND reaction_key=?`
    ).run(userId, reactionKey);
    if (upd.changes === 0) {
        db.prepare(
            `INSERT OR IGNORE INTO user_recent_reactions(user_id, reaction_key, last_used_at)
       VALUES(?,?,CURRENT_TIMESTAMP)`
        ).run(userId, reactionKey);
    }
}

router.get('/dm/messages/:id/reactions', requireAuth, (req, res) => {
    const msgId = +req.params.id;
    const pol = getMessagePolicy(msgId);
    if (!pol) return res.status(404).json({ error: 'not_found' });
    if (!isMember(pol.conversation_id, req.userId)) return res.status(403).json({ error: 'forbidden' });

    try {
        const counts = db
            .prepare(
                `
      SELECT reaction_key,
             MIN(kind)            AS kind,
             MAX(unicode)         AS unicode,
             MAX(custom_emoji_id) AS custom_emoji_id,
             COUNT(*)             AS count
      FROM dm_message_reactions
      WHERE message_id=?
      GROUP BY reaction_key
      ORDER BY count DESC, reaction_key ASC
    `
            )
            .all(msgId);

        const allUsers = db
            .prepare(
                `
      SELECT reaction_key, user_id
      FROM dm_message_reactions
      WHERE message_id=?
      ORDER BY created_at ASC
    `
            )
            .all(msgId);

        const mapUsers = new Map();
        for (const r of allUsers) {
            if (!mapUsers.has(r.reaction_key)) mapUsers.set(r.reaction_key, []);
            mapUsers.get(r.reaction_key).push(r.user_id);
        }

        const items = counts.map((c) => {
            const users = mapUsers.get(c.reaction_key) || [];
            return {
                reaction_key: c.reaction_key,
                kind: c.kind,
                unicode: c.unicode || null,
                custom_emoji_id: c.custom_emoji_id || null,
                count: c.count | 0,
                user_ids: users,
                reacted_by_me: users.includes(req.userId),
            };
        });

        res.json({ ok: true, reactable: pol.reactable, mode: pol.mode, items });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

function parseReactionKey(key) {
    if (!key || typeof key !== 'string') return null;
    if (key.startsWith('u:')) {
        const unicode = key.slice(2);
        if (!unicode) return null;
        return { kind: 'emoji', reaction_key: `u:${unicode}`, unicode, custom_emoji_id: null };
    }
    if (key.startsWith('c:')) {
        const id = +key.slice(2);
        if (!Number.isFinite(id) || id <= 0) return null;
        return { kind: 'custom', reaction_key: `c:${id}`, unicode: null, custom_emoji_id: id };
    }
    return null;
}

function reactionsAllowedFor(msg, settings, rxKind) {
    const on = !!(settings?.reactable ?? 1); // default enabled in schema
    const mode = settings?.reaction_mode || 'both';
    if (!on || mode === 'none') return false;
    if (settings?.reactions_effective_from) {
        const msgMs = new Date(msg.created_at).getTime();
        const effMs = new Date(settings.reactions_effective_from).getTime();
        if (Number.isFinite(msgMs) && Number.isFinite(effMs) && msgMs < effMs) return false;
    }
    if (mode === 'emoji' && rxKind !== 'emoji') return false;
    if (mode === 'custom' && rxKind !== 'custom') return false;
    return true;
}

router.post('/dm/messages/:id/reactions/toggle', requireAuth, (req, res) => {
    const reqId = Math.random().toString(36).slice(2, 8);
    const tag = (m) => `${m} (#${reqId})`;

    try {
        rxDbg(tag('hit'), {
            method: req.method,
            url: req.originalUrl || req.url,
            params: req.params,
            headers: {
                'content-type': req.headers['content-type'],
                'accept': req.headers['accept'],
                'x-requested-with': req.headers['x-requested-with'],
            },
            bodyType: typeof req.body,
            body: req.body,
            userId: req.userId,
        });

        const msgId = +req.params.id | 0;
        const parsed = parseReactionKey((req.body && req.body.reaction_key) || '');
        rxDbg(tag('parsed'), { msgId, parsed });

        if (!msgId || !parsed) {
            rxDbg(tag('bad_request'), {});
            return res.status(400).json({ error: 'bad_request' });
        }

        // Verify membership + load message
        const msg = db.prepare(`
      SELECT m.id, m.conversation_id, m.created_at
      FROM dm_messages m
      JOIN dm_members mm
        ON mm.conversation_id = m.conversation_id AND mm.user_id = ?
      WHERE m.id = ?
    `).get(req.userId, msgId);

        rxDbg(tag('msg_lookup'), { found: !!msg, conv_id: msg?.conversation_id });

        if (!msg) return res.status(404).json({ error: 'not_found_or_forbidden' });

        // Load settings (dm_settings)
        const st = db.prepare(`
      SELECT reactable, reaction_mode, reactions_effective_from
      FROM dm_settings WHERE conversation_id = ?
    `).get(msg.conversation_id) || {};

        const allowed = reactionsAllowedFor(msg, st, parsed.kind);
        rxDbg(tag('policy'), { settings: st, allowed });

        if (!allowed) return res.status(403).json({ error: 'reactions_disabled' });

        // Toggle (exists? delete : insert)
        const exists = db.prepare(`
      SELECT 1 FROM dm_message_reactions
      WHERE message_id=? AND user_id=? AND reaction_key=?
    `).get(msgId, req.userId, parsed.reaction_key);

        rxDbg(tag('exists?'), { exists: !!exists });

        if (exists) {
            const del = db.prepare(`
        DELETE FROM dm_message_reactions
        WHERE message_id=? AND user_id=? AND reaction_key=?
      `).run(msgId, req.userId, parsed.reaction_key);
            rxDbg(tag('deleted'), { changes: del.changes });

            const count = db.prepare(`
        SELECT COUNT(*) AS c FROM dm_message_reactions
        WHERE message_id=? AND reaction_key=?
      `).get(msgId, parsed.reaction_key)?.c || 0;

            rxDbg(tag('resp(off)'), { count });
            return res.json({ ok: true, toggled: 'off', message_id: msgId, reaction_key: parsed.reaction_key, count });
        }

        // INSERT (ensure kind/unicode/custom_emoji_id are set correctly)
        const ins = db.prepare(`
      INSERT INTO dm_message_reactions
        (message_id, user_id, kind, reaction_key, unicode, custom_emoji_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(msgId, req.userId, parsed.kind, parsed.reaction_key, parsed.unicode, parsed.custom_emoji_id);
        rxDbg(tag('inserted'), { changes: ins.changes });

        // Recent reactions — safe upsert that works on old SQLite too
        safeUpsertRecentReaction(db, req.userId, parsed.reaction_key);
        rxDbg(tag('recent-upsert'), { reaction_key: parsed.reaction_key });

        const count = db.prepare(`
      SELECT COUNT(*) AS c FROM dm_message_reactions
      WHERE message_id=? AND reaction_key=?
    `).get(msgId, parsed.reaction_key)?.c || 0;

        rxDbg(tag('resp(on)'), { count });
        return res.json({ ok: true, toggled: 'on', message_id: msgId, reaction_key: parsed.reaction_key, count });

    } catch (e) {
        // Always JSON (prevents the "Unexpected token" crash on the client)
        rxDbg(tag('error'), { message: e.message, name: e.name, stack: e.stack });
        return res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

// Recent reactions (keep both endpoints; same data source)
function recentReactionsForUser(userId) {
    const rows = db
        .prepare(
            `
      SELECT r.reaction_key, r.last_used_at,
             CASE WHEN r.reaction_key LIKE 'u:%' THEN 0 ELSE 1 END AS is_custom,
             CASE WHEN r.reaction_key LIKE 'c:%' THEN CAST(SUBSTR(r.reaction_key,3) AS INTEGER) END AS emoji_id
      FROM user_recent_reactions r
      WHERE r.user_id=?
      ORDER BY r.last_used_at DESC
      LIMIT 10
    `
        )
        .all(userId);

    const withUrls = rows.map((r) => {
        let url = null;
        if (r.is_custom && r.emoji_id) {
            const file = db.prepare(`SELECT filename FROM custom_emojis WHERE id=?`).get(r.emoji_id)?.filename;
            if (file) url = publicEmojiURL(file);
        }
        return {
            key: r.reaction_key,
            is_custom: !!r.is_custom,
            emoji_id: r.emoji_id || null,
            used_at: r.last_used_at,
            url,
        };
    });
    return withUrls;
}
router.get('/dm/reactions/recents', requireAuth, (req, res) => {
    try {
        res.json({ ok: true, items: recentReactionsForUser(req.userId) });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});
router.get('/dm/reactions/recent', requireAuth, (req, res) => {
    try {
        res.json({ ok: true, items: recentReactionsForUser(req.userId) });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

/* ====== custom reactions library (unified schema) ====== */

router.get('/dm/reactions/custom/library', requireAuth, (req, res) => {
    try {
        const rows = db
            .prepare(
                `
      SELECT e.id, e.filename, e.mime_type, u.created_at
      FROM user_custom_emojis u
      JOIN custom_emojis e ON e.id = u.emoji_id
      WHERE u.user_id=?
      ORDER BY u.created_at DESC
    `
            )
            .all(req.userId);

        const items = rows.map((e) => ({
            id: e.id,
            name: null,
            slug: null,
            mime_type: e.mime_type || 'image/png',
            url: publicEmojiURL(e.filename),
            width: null,
            height: null,
        }));
        res.json({ ok: true, items });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

router.post('/dm/reactions/custom/upload', requireAuth, uploadEmoji.single('image'), (req, res) => {
    const file = req.file;
    if (!file || !file.buffer || file.size <= 0) return res.status(400).json({ error: 'no_file' });

    const mt = (file.mimetype || '').toLowerCase();
    const ext = mt === 'image/png' ? 'png'
        : mt === 'image/webp' ? 'webp'
            : mt === 'image/gif' ? 'gif'
                : mt === 'image/jpeg' ? 'jpg'
                    : null;
    if (!ext) return res.status(415).json({ error: 'bad_type' });

    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const filename = `${hash}.${ext}`;
    const outPath = path.join(EMOJI_DIR, filename);

    try {
        if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, file.buffer);
    } catch (e) {
        return res.status(500).json({ error: 'write_failed', detail: String(e.message || e) });
    }

    const tx = db.transaction(() => {
        // Master record (idempotent on sha256)
        db.prepare(`
      INSERT INTO custom_emojis(sha256, filename, mime_type, uploader_id, created_at)
      VALUES(?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(sha256) DO UPDATE SET filename=excluded.filename, mime_type=excluded.mime_type
    `).run(hash, filename, mt, req.userId);

        const emoji = db.prepare(`SELECT id, filename, mime_type FROM custom_emojis WHERE sha256=?`).get(hash);

        // Add to my library (limit 100)
        const count = db.prepare(`SELECT COUNT(*) AS n FROM user_custom_emojis WHERE user_id=?`).get(req.userId)?.n | 0;
        if (count >= 100) throw new Error('limit');

        db.prepare(`
      INSERT OR IGNORE INTO user_custom_emojis(user_id, emoji_id, created_at)
      VALUES(?,?,CURRENT_TIMESTAMP)
    `).run(req.userId, emoji.id);

        return emoji;
    });

    try {
        const emoji = tx();
        res.json({
            ok: true,
            emoji: {
                id: emoji.id,
                mime_type: emoji.mime_type,
                url: publicEmojiURL(emoji.filename),
                width: null,
                height: null
            }
        });
    } catch (e) {
        if (String(e.message).includes('limit')) return res.status(400).json({ error: 'library_limit_100' });
        return res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

// Bookmark/unbookmark an existing custom emoji (reactions namespace)
router.post('/dm/reactions/custom/:id/bookmark', requireAuth, (req, res) => {
    const id = +req.params.id;
    if (!id) return res.status(400).json({ error: 'bad_id' });
    const exists = db.prepare(`SELECT 1 FROM custom_emojis WHERE id=?`).get(id);
    if (!exists) return res.status(404).json({ error: 'not_found' });

    try {
        // enforce limit 100
        const count = db.prepare(`SELECT COUNT(*) AS n FROM user_custom_emojis WHERE user_id=?`).get(req.userId)?.n | 0;
        if (count >= 100) return res.status(400).json({ error: 'library_limit_100' });

        db.prepare(`
      INSERT OR IGNORE INTO user_custom_emojis(user_id, emoji_id, created_at)
      VALUES(?,?,CURRENT_TIMESTAMP)
    `).run(req.userId, id);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});
router.delete('/dm/reactions/custom/:id/bookmark', requireAuth, (req, res) => {
    const id = +req.params.id;
    if (!id) return res.status(400).json({ error: 'bad_id' });
    try {
        db.prepare(`DELETE FROM user_custom_emojis WHERE user_id=? AND emoji_id=?`).run(req.userId, id);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

/* ====== static serving for custom emoji files ====== */
router.use('/media/custom-emojis', express.static(EMOJI_DIR, {
    maxAge: '31536000', // 1y
    immutable: true,
    fallthrough: true,
}));

module.exports = { router, removeUserFromOwnerGroups };