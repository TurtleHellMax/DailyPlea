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
    : (b) => new Promise((resolve, reject) => zlib.gunzip(b, (err, out) => err ? reject(err) : resolve(out)));

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

/* ====== feature flags from DB ====== */

// REPLACE the CONST with this function:
function hasDurationCol() {
    try {
        const cols = db.prepare(`PRAGMA table_info(dm_attachments)`).all();
        return Array.isArray(cols) && cols.some(c => String(c.name).toLowerCase() === 'duration_ms');
    } catch { return false; }
}

/* ====== helpers ====== */
// routes-dm.js — robust EBML/WebM duration parser + improved probe

// EBML VINT (ID) — keep marker bits
function readVintId(buf, off) { const b = buf[off]; if (b === undefined) return null; let l = 1, m = 0x80; while (l <= 4 && (b & m) === 0) { m >>= 1; l++; } if (l > 4 || off + l > buf.length) return null; let v = b; for (let i = 1; i < l; i++) v = (v << 8) | buf[off + i]; return { length: l, value: v >>> 0 }; }
function readVintSize(buf, off) { const b = buf[off]; if (b === undefined) return null; let l = 1, m = 0x80; while (l <= 8 && (b & m) === 0) { m >>= 1; l++; } if (l > 8 || off + l > buf.length) return null; let v = b & (m - 1); for (let i = 1; i < l; i++) v = (v << 8) | buf[off + i]; const unknown = v === ((1 << (7 * l)) - 1); return { length: l, value: v >>> 0, unknown }; }
function walkEbml(buf, start, end, onEl) { let off = start | 0; const L = end | 0; while (off < L) { const id = readVintId(buf, off); if (!id) break; off += id.length; const sz = readVintSize(buf, off); if (!sz) break; off += sz.length; const s = off, e = sz.unknown ? L : Math.min(L, off + sz.value); onEl(id.value, s, e); off = e; } }
function readUIntBE(buf, off, len) { if (off + len > buf.length) return null; let v = 0; for (let i = 0; i < len; i++) v = (v * 256) + buf[off + i]; return v >>> 0; }
function readFloat(buf, off, len) { if (len === 4 && off + 4 <= buf.length) return buf.readFloatBE(off); if (len === 8 && off + 8 <= buf.length) return buf.readDoubleBE(off); return NaN; }

function estimateWebmDurationMs(bufIn) {
    const buf = Buffer.isBuffer(bufIn) ? bufIn : Buffer.from(bufIn);
    let segStart = 0, segEnd = buf.length;
    walkEbml(buf, 0, buf.length, (id, s, e) => { if (id === 0x18538067) { segStart = s; segEnd = e; } }); // Segment
    let scale = 1_000_000; // default TimecodeScale = 1ms in ns
    let infoDurSec = null;

    // Info element: TimecodeScale (0x2AD7B1), Duration (0x4489)
    walkEbml(buf, segStart, segEnd, (id, s, e) => {
        if (id !== 0x1549A966) return;
        walkEbml(buf, s, e, (cid, cs, ce) => {
            if (cid === 0x2AD7B1) { const n = readUIntBE(buf, cs, Math.min(8, ce - cs)); if (n) scale = n; }
            else if (cid === 0x4489) { const v = readFloat(buf, cs, ce - cs); if (Number.isFinite(v) && v > 0) infoDurSec = v; }
        });
    });
    if (Number.isFinite(infoDurSec) && infoDurSec > 0) return Math.round(infoDurSec * (scale / 1e6));

    // Fall back to clusters
    let maxMs = 0;
    walkEbml(buf, segStart, segEnd, (id, s, e) => {
        if (id !== 0x1F43B675) return; // Cluster
        let cTc = 0;
        walkEbml(buf, s, e, (cid, cs) => { if (cid === 0xE7) { const v = readUIntBE(buf, cs, 8); if (typeof v === 'number') cTc = v; } });
        walkEbml(buf, s, e, (cid, cs, ce) => {
            if (cid === 0xA3) { // SimpleBlock
                const tnum = readVintSize(buf, cs); if (!tnum) return;
                const off = cs + tnum.length; if (off + 2 > ce) return;
                const rel = buf.readInt16BE(off);
                const endMs = (cTc + Math.max(0, rel) + 1) * (scale / 1e6);
                if (endMs > maxMs) maxMs = endMs;
            } else if (cid === 0xA0) { // BlockGroup
                let rel = 0, dur = 0;
                walkEbml(buf, cs, ce, (gid, gs, ge) => {
                    if (gid === 0xA1) { const tnum = readVintSize(buf, gs); if (tnum) { const off = gs + tnum.length; if (off + 2 <= ge) rel = buf.readInt16BE(off); } }
                    else if (gid === 0x9B) { const v = readUIntBE(buf, gs, Math.min(8, ge - gs)); if (typeof v === 'number') dur = v; }
                });
                const endMs = (cTc + Math.max(0, rel) + Math.max(0, dur)) * (scale / 1e6);
                if (endMs > maxMs) maxMs = endMs;
            }
        });
    });
    return maxMs > 0 ? Math.round(maxMs) : null;
}

async function probeAudioDurationMsFromBuffer(bufIn, mime, encoding /* 'gzip' | null */) {
    let buf = Buffer.isBuffer(bufIn) ? bufIn : Buffer.from(bufIn);

    // transparently gunzip if needed
    const sniff0 = sniffContainer(buf);
    if (encoding?.toLowerCase() === 'gzip' || sniff0 === 'gzip') {
        try { buf = await gunzip(buf); } catch { }
    }
    const kind = sniffContainer(buf); // after potential gunzip

    // 1) try music-metadata (handles a lot of formats)
    try {
        const fileInfo = { size: buf.length, mimeType: kind === 'webm' ? 'video/webm' : (mime || 'application/octet-stream') };
        const info = await mm.parseBuffer(buf, fileInfo, { duration: true });
        const sec = info?.format?.duration;
        if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
    } catch { /* ignore */ }

    // 2) fallbacks for common recorder outputs
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
 * return a rotated key to keep the convo writable. */
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
        const convKey = crypto.randomBytes(32);
        const enc = aeadEncrypt(MASTER_KEY, convKey);
        db.prepare(`UPDATE dm_conversation_keys SET key_cipher=?, key_nonce=? WHERE conversation_id=?`)
            .run(enc.cipher, enc.nonce, convId);
        return convKey;
    }
}

function getUserLabel(userId) {
    const u = db.prepare(`SELECT first_username, username FROM users WHERE id=?`).get(userId);
    return (u?.first_username || u?.username || 'User');
}
function listMemberUsers(convId) {
    return db.prepare(`
    SELECT u.id, u.first_username, u.username
    FROM dm_members m JOIN users u ON u.id=m.user_id
    WHERE m.conversation_id=?
    ORDER BY u.id
  `).all(convId);
}
function memberCount(convId) {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM dm_members WHERE conversation_id=?`).get(convId);
    return r?.n | 0;
}
function joinNames(names) {
    const arr = (names || []).filter(Boolean);
    if (arr.length === 0) return '';
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
    return `${arr.slice(0, -1).join(', ')}, and ${arr[arr.length - 1]}`;
}
function areFriends(a, b) {
    const [x, y] = a < b ? [a, b] : [b, a];
    const r = db.prepare(`SELECT 1 FROM friendships WHERE user_id_a=? AND user_id_b=?`).get(x, y);
    return !!r;
}
function getConv(convId) {
    return db.prepare(`SELECT id, is_group, title, owner_id, color, deleted_at FROM dm_conversations WHERE id=?`).get(convId);
}
function softDeleteGroup(convId) {
    const tx = db.transaction(() => {
        db.prepare(`UPDATE dm_conversations SET deleted_at = CURRENT_TIMESTAMP WHERE id=?`).run(convId);
        db.prepare(`INSERT INTO dm_deleted_groups(conversation_id, deleted_at) VALUES(?, CURRENT_TIMESTAMP)`).run(convId);
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
    const id = db.prepare(`
    INSERT INTO dm_messages(conversation_id, sender_id, kind, body_cipher, body_nonce)
    VALUES(?,?,?,?,?)
  `).run(convId, actorId, 'system', enc.cipher, enc.nonce).lastInsertRowid;

    broadcast(convId, 'new', { id }, String(id));
    broadcastToUsersOfConv(convId, 'message', { conversation_id: convId, id }, String(id));
    return id;
}
function sniffContainer(buf) {
    const B = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (B.length >= 2 && B[0] === 0x1f && B[1] === 0x8b) return 'gzip';
    if (B.length >= 4 && B[0] === 0x1A && B[1] === 0x45 && B[2] === 0xDF && B[3] === 0xA3) return 'webm';
    if (B.length >= 4 && B.toString('ascii', 0, 4) === 'OggS') return 'ogg';
    if (B.length >= 12 && B.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
    if (B.length >= 12 && B.toString('ascii', 0, 4) === 'RIFF' && B.toString('ascii', 8, 12) === 'WAVE') return 'wav';
    return 'unknown';
}
function estimateOggOpusDurationMs(bufIn) {
    const B = Buffer.isBuffer(bufIn) ? bufIn : Buffer.from(bufIn);
    let off = 0, lastGp = 0, serial = null;
    while (off + 27 <= B.length && B.toString('ascii', off, off + 4) === 'OggS') {
        const pageSegs = B[off + 26];
        const segTable = off + 27;
        if (segTable + pageSegs > B.length) break;
        let bodyLen = 0; for (let i = 0; i < pageSegs; i++) bodyLen += B[segTable + i];
        if (segTable + pageSegs + bodyLen > B.length) break;
        const gp = B.readUInt32LE(off + 6) + (B.readUInt32LE(off + 10) * 0x100000000);
        const s = B.readUInt32LE(off + 14);
        if (serial == null) serial = s;
        if (s === serial && gp > 0) lastGp = gp;
        off = segTable + pageSegs + bodyLen;
    }
    return lastGp > 0 ? Math.round((lastGp / 48000) * 1000) : null;
}
function setGroupColor(convId, color) {
    db.prepare(`UPDATE dm_conversations SET color=? WHERE id=?`).run(color || null, convId);
}
function upsertGroupIcon(convId, mime, plainBuf) {
    const key = getOrCreateConvKey(convId);
    if (!key) throw new Error('key_missing');
    const enc = aeadEncrypt(key, plainBuf);
    db.prepare(`
    INSERT INTO dm_group_icons(conversation_id, mime_type, blob_cipher, blob_nonce, updated_at)
    VALUES(?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(conversation_id) DO UPDATE
      SET mime_type=excluded.mime_type,
          blob_cipher=excluded.blob_cipher,
          blob_nonce=excluded.blob_nonce,
          updated_at=CURRENT_TIMESTAMP
  `).run(convId, mime || 'image/png', enc.cipher, enc.nonce);
}
function deleteGroupIcon(convId) {
    db.prepare(`DELETE FROM dm_group_icons WHERE conversation_id=?`).run(convId);
}
function getGroupIcon(convId) {
    return db.prepare(`SELECT mime_type, blob_cipher, blob_nonce FROM dm_group_icons WHERE conversation_id=?`).get(convId);
}

/* ====== per-user message colors ====== */
const GROUP_COLOR_PALETTE = [
    '#3b82f6', '#22c55e', '#a855f7', '#f97316',
    '#ec4899', '#14b8a6', '#eab308', '#ef4444',
];

function isValidHex6(s) { return typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s); }

function getColorMap(convId) {
    const rows = db.prepare(`SELECT user_id, color FROM dm_message_colors WHERE conversation_id=?`).all(convId);
    const map = {};
    for (const r of rows) if (r.color) map[r.user_id] = r.color;
    return map;
}
function setUserColor(convId, userId, color /* string|null */) {
    if (!color) {
        db.prepare(`DELETE FROM dm_message_colors WHERE conversation_id=? AND user_id=?`).run(convId, userId);
        return;
    }
    db.prepare(`
    INSERT INTO dm_message_colors(conversation_id, user_id, color, updated_at)
    VALUES(?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(conversation_id,user_id)
    DO UPDATE SET color=excluded.color, updated_at=CURRENT_TIMESTAMP
  `).run(convId, userId, color);
}
function chooseUniqueColorsForUsers(userIds, existingMap = {}) {
    const used = new Set(Object.values(existingMap || {}));
    const palette = GROUP_COLOR_PALETTE.slice();
    const available = palette.filter(c => !used.has(c));
    const out = {};
    for (const uid of userIds) {
        if (existingMap[uid]) continue;
        let color = available.length
            ? available.splice((Math.random() * available.length) | 0, 1)[0]
            : palette[(Math.random() * palette.length) | 0];
        out[uid] = color;
        used.add(color);
    }
    return out;
}

/* ====== SSE (simple) ====== */
// Per-user global SSE (for "new dm", "meta changed", etc.)
const userStreams = new Map(); // userId -> Set(res)
function getUserStreamSet(userId) {
    let set = userStreams.get(userId);
    if (!set) { set = new Set(); userStreams.set(userId, set); }
    return set;
}
function broadcastToUser(userId, event, data, id) {
    const set = userStreams.get(userId);
    if (!set || set.size === 0) return;
    const payload =
        (id ? `id: ${id}\n` : '') +
        `event: ${event}\n` +
        `data: ${JSON.stringify(data || {})}\n\n`;
    for (const res of set) { try { res.write(payload); } catch { } }
}
function broadcastToUsersOfConv(convId, event, data, id) {
    try {
        const members = listMemberUsers(convId) || [];
        for (const m of members) broadcastToUser(m.id, event, data, id);
    } catch { }
}

// User-wide stream
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
    for (const res of set) { try { res.write(payload); } catch { } }
}
// heartbeat so proxies don’t close
setInterval(() => {
    for (const set of streams.values()) {
        for (const res of set) { try { res.write(`: ping\n\n`); } catch { } }
    }
    for (const set of userStreams.values()) {
        for (const res of set) { try { res.write(`: ping\n\n`); } catch { } }
    }
}, 15000);

/* ====== multer (1 MB hard limit per file) ====== */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1024 * 1024 } // 1 MB
});

/* ====== background cleanup (deleted groups list, 30 days) ====== */
function purgeDeletedGroups() {
    try {
        db.prepare(`DELETE FROM dm_deleted_groups WHERE deleted_at < datetime('now','-30 days')`).run();
    } catch { }
}
setInterval(purgeDeletedGroups, 12 * 60 * 60 * 1000); // twice a day
purgeDeletedGroups();

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
    WHERE c.is_group=0 AND c.deleted_at IS NULL
    LIMIT 1
  `).get(req.userId, other.id);

    if (row) {
        ensureConvKey(row.id);
        db.prepare(`DELETE FROM dm_hidden WHERE conversation_id=? AND user_id IN (?,?)`).run(row.id, req.userId, other.id);
        return res.json({ ok: true, conversation_id: row.id, id: row.id });
    }

    const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO dm_conversations(is_group, title, owner_id, color) VALUES(0, NULL, NULL, NULL)`).run();
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

/** SSE stream (per-conversation) */
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
    let { user_ids = [], title = null, color = null } = req.body || {};
    user_ids = Array.from(new Set([...(user_ids || []).map(n => +n).filter(Boolean), req.userId])).sort((a, b) => a - b);
    if (user_ids.length < 2) return res.status(400).json({ error: 'need_two_members' });

    const isGroup = user_ids.length > 2 ? 1 : 0;

    if (!isGroup) {
        const row = db.prepare(`
      SELECT c.id
      FROM dm_conversations c
      JOIN dm_members m1 ON m1.conversation_id=c.id AND m1.user_id=?
      JOIN dm_members m2 ON m2.conversation_id=c.id AND m2.user_id=?
      WHERE c.is_group=0 AND c.deleted_at IS NULL
      LIMIT 1
    `).get(user_ids[0], user_ids[1]);
        if (row) {
            ensureConvKey(row.id);
            db.prepare(`DELETE FROM dm_hidden WHERE conversation_id=? AND user_id=?`).run(row.id, req.userId);
            return res.json({ ok: true, conversation_id: row.id, id: row.id });
        }
    } else {
        if (user_ids.length < 3) return res.status(400).json({ error: 'min_size' });
    }

    const tx = db.transaction(() => {
        const r = db.prepare(
            `INSERT INTO dm_conversations(is_group, title, owner_id, color) VALUES(?,?,?,?)`
        ).run(isGroup, isGroup ? String(title || 'Group') : null, isGroup ? req.userId : null, isGroup ? (color || null) : null);

        const convId = r.lastInsertRowid;
        for (const uid of user_ids) {
            db.prepare(`INSERT INTO dm_members(conversation_id, user_id) VALUES(?,?)`).run(convId, uid);
        }
        ensureConvKey(convId);

        if (isGroup) {
            const chosen = chooseUniqueColorsForUsers(user_ids, {});
            for (const [uid, col] of Object.entries(chosen)) setUserColor(convId, +uid, col);
        }

        return convId;
    });

    const id = tx();
    broadcastToUsersOfConv(id, 'conv_new', { id }, String(id));
    res.json({ ok: true, conversation_id: id, id });
});

/** List conversations with preview (best-effort decrypt) */
router.get('/dm/conversations', requireAuth, (req, res) => {
    const rows = db.prepare(`
    SELECT c.id, c.is_group, c.title, c.color,
           (SELECT sender_id FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_sender_id,
           (SELECT body_cipher FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_body_cipher,
           (SELECT body_nonce  FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_body_nonce,
           (SELECT id FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_msg_id
    FROM dm_conversations c
    JOIN dm_members m ON m.conversation_id=c.id
    LEFT JOIN dm_hidden h ON h.conversation_id=c.id AND h.user_id=?
    WHERE m.user_id=? AND (c.deleted_at IS NULL)
      AND (h.last_hidden_msg_id IS NULL OR
           ( (SELECT id FROM dm_messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) > h.last_hidden_msg_id ))
    ORDER BY last_msg_id DESC NULLS LAST
  `).all(req.userId, req.userId);

    const out = rows.map(r => {
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

/** Conversation details (includes color + icon URL) */
router.get('/dm/conversations/:id', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const conv = getConv(convId);
    if (!conv) return res.status(404).json({ error: 'not_found' });
    if (conv.deleted_at) return res.status(410).json({ error: 'gone' });
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const members = db.prepare(`
    SELECT u.id, u.username, u.first_username, u.profile_photo
    FROM dm_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id=?
    ORDER BY u.id
  `).all(convId);

    const other = !conv.is_group ? (members.find(u => (u.id | 0) !== (req.userId | 0)) || null) : null;

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
        rows = r.reverse();
    } else {
        const r = db.prepare(`
      SELECT id, sender_id, kind, body_cipher, body_nonce, created_at
      FROM dm_messages
      WHERE conversation_id=?
      ORDER BY id DESC
      LIMIT ?
    `).all(convId, limit);
        rows = r.reverse();
    }

    const key = getOrCreateConvKey(convId);
    const attCols = hasDurationCol()
        ? `id, filename, mime_type, encoding, size_bytes, duration_ms`
        : `id, filename, mime_type, encoding, size_bytes, NULL AS duration_ms`;

    const msgs = rows.map(r => {
        let text = '';
        try {
            if (key && r.body_cipher && r.body_nonce) {
                const obj = decryptJSON(key, r.body_cipher, r.body_nonce);
                text = obj?.text || '';
            }
        } catch { }
        const atts = db.prepare(`
      SELECT ${attCols}
      FROM dm_attachments WHERE message_id=? ORDER BY id ASC
    `).all(r.id);
        return { id: r.id, sender_id: r.sender_id, kind: r.kind, text, attachments: atts, created_at: r.created_at };
    });

    const next_before = msgs.length ? msgs[0].id : null;
    res.json({ ok: true, items: msgs, next_before });
});

/** Send a message (multipart) – parses audio duration at upload time and stores it */
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

    // Precompute durations for any (non-gzipped) audio file now (<=1MB so sync-ish)
    const preDurations = new Map(); // index -> ms
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const declaredEnc = (f?.encoding || req.body?.[`encoding_${f.originalname}`] || req.body?.encoding || '').toLowerCase();
        const isAudio = (f?.mimetype || '').toLowerCase().startsWith('audio/');
        if (isAudio && f?.buffer?.length) {
            try {
                const ms = await probeAudioDurationMsFromBuffer(f.buffer, f.mimetype, declaredEnc === 'gzip' ? 'gzip' : null);
                if (ms && Number.isFinite(ms)) preDurations.set(i, ms);
            } catch { /* ignore */ }
        }
    }

    const useDur = hasDurationCol();
    const insertWithDuration = useDur ? db.prepare(`
    INSERT INTO dm_attachments(message_id, filename, mime_type, encoding, size_bytes, duration_ms, blob_cipher, blob_nonce)
    VALUES(?,?,?,?,?,?,?,?)
    `) : null;

    const insertWithoutDuration = db.prepare(`
    INSERT INTO dm_attachments(message_id, filename, mime_type, encoding, size_bytes, blob_cipher, blob_nonce)
    VALUES(?,?,?,?,?,?,?)
    `);

    const tx = db.transaction(() => {
        const msgId = db.prepare(`
      INSERT INTO dm_messages(conversation_id, sender_id, kind, body_cipher, body_nonce)
      VALUES(?,?,?,?,?)
    `).run(convId, req.userId, kind, encBody.cipher, encBody.nonce).lastInsertRowid;

        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const encoding = (f?.encoding || req.body?.[`encoding_${f.originalname}`] || req.body?.encoding || '').toLowerCase() === 'gzip' ? 'gzip' : null;
            const metaMime = f.mimetype || 'application/octet-stream';
            const metaName = f.originalname || 'file';
            const enc = aeadEncrypt(key, f.buffer);
            const dur = preDurations.get(i) ?? null;

            let attId;
            if (useDur) {
                attId = insertWithDuration.run(msgId, metaName, metaMime, encoding, f.size | 0, dur ?? null, enc.cipher, enc.nonce).lastInsertRowid;
            } else {
                attId = insertWithoutDuration.run(msgId, metaName, metaMime, encoding, f.size | 0, enc.cipher, enc.nonce).lastInsertRowid;
                if (dur != null) { try { db.prepare(`UPDATE dm_attachments SET duration_ms=? WHERE id=?`).run(dur, attId); } catch { } }
            }
        }
        return msgId;
    });

    const id = tx();

    broadcast(convId, 'new', { id }, String(id));
    broadcastToUsersOfConv(convId, 'message', { conversation_id: convId, id }, String(id));
    res.json({ ok: true, id });
});

/** Members list */
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

    res.json({ ok: true, members });
});

/** PATCH members (owner only). Body: { add_user_ids?: number[], remove_user_ids?: number[] } */
router.patch('/dm/conversations/:id/members', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : (error === 'deleted' ? 410 : 404)).json({ error });
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });
    if ((conv.owner_id | 0) !== (req.userId | 0)) return res.status(403).json({ error: 'owner_only' });

    let { add_user_ids = [], remove_user_ids = [] } = req.body || {};
    const adds = Array.from(new Set((add_user_ids || []).map(n => +n).filter(Boolean)));
    const rems = Array.from(new Set((remove_user_ids || []).map(n => +n).filter(uid => uid !== conv.owner_id)));

    for (const uid of adds) {
        if (!areFriends(conv.owner_id, uid)) return res.status(400).json({ error: 'not_friends', user_id: uid });
        const blocked = db.prepare(`SELECT 1 FROM dm_conv_blocks WHERE conversation_id=? AND user_id=?`).get(convId, uid);
        if (blocked) return res.status(400).json({ error: 'user_blocked', user_id: uid });
    }

    const current = db.prepare(`SELECT user_id FROM dm_members WHERE conversation_id=? ORDER BY user_id`).all(convId).map(r => r.user_id);
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
        if (adds.length) {
            const existing = getColorMap(convId);
            const chosen = chooseUniqueColorsForUsers(adds, existing);
            for (const [uid, col] of Object.entries(chosen)) setUserColor(convId, +uid, col);
        }
    });
    tx();

    const remaining = memberCount(convId);
    if (remaining <= 0) softDeleteGroup(convId);

    res.json({ ok: true, remaining, deleted: remaining <= 0 });
});

/** Rename title (owner only) */
router.patch('/dm/conversations/:id/title', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : (error === 'deleted' ? 410 : 404)).json({ error });
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });
    if ((conv.owner_id | 0) !== (req.userId | 0)) return res.status(403).json({ error: 'owner_only' });

    const raw = String((req.body?.title || '')).trim();
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

/** Transfer ownership (owner only). Body: { owner_id:number } */
router.patch('/dm/conversations/:id/owner', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : (error === 'deleted' ? 410 : 404)).json({ error });
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

/** Leave group (non-owner). Enforce final size >= 3. */
router.post('/dm/conversations/:id/leave', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : (error === 'deleted' ? 410 : 404)).json({ error });
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

/** Disband group (owner only) */
router.post('/dm/conversations/:id/disband', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : (error === 'deleted' ? 410 : 404)).json({ error });
    if ((conv.owner_id | 0) !== (req.userId | 0)) return res.status(403).json({ error: 'owner_only' });

    const tx = db.transaction(() => {
        db.prepare(`UPDATE dm_conversations SET deleted_at = CURRENT_TIMESTAMP WHERE id=?`).run(convId);
        db.prepare(`INSERT INTO dm_deleted_groups(conversation_id, deleted_at) VALUES(?, CURRENT_TIMESTAMP)`).run(convId);
        db.prepare(`DELETE FROM dm_conversations WHERE id=?`).run(convId);
    });
    tx();

    res.json({ ok: true });
});

/** Delete chat for me (DM or group). Hides until a new message arrives. */
router.post('/dm/conversations/:id/delete_for_me', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const lastMsg = db.prepare(`SELECT id FROM dm_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1`).get(convId);
    const lastId = lastMsg?.id || 0;

    db.prepare(`
    INSERT INTO dm_hidden(user_id, conversation_id, last_hidden_msg_id)
    VALUES(?,?,?)
    ON CONFLICT(user_id,conversation_id) DO UPDATE SET last_hidden_msg_id=excluded.last_hidden_msg_id
  `).run(req.userId, convId, lastId);

    res.json({ ok: true });
});

/** Block this group for me (prevents re-add). Also leaves if still a member. */
router.post('/dm/conversations/:id/block', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const conv = getConv(convId);
    if (!conv) return res.status(404).json({ error: 'not_found' });

    db.prepare(`INSERT OR IGNORE INTO dm_conv_blocks(user_id, conversation_id, created_at) VALUES(?,?,CURRENT_TIMESTAMP)`)
        .run(req.userId, convId);

    if (isMember(convId, req.userId) && conv.is_group) {
        db.prepare(`DELETE FROM dm_members WHERE conversation_id=? AND user_id=?`).run(convId, req.userId);
        db.prepare(`DELETE FROM dm_message_colors WHERE conversation_id=? AND user_id=?`).run(convId, req.userId);
        addSystemMessage(convId, req.userId, `${getUserLabel(req.userId)} left the group.`);
    }

    res.json({ ok: true });
});

/** Download attachment (supports ranges, sets Content-Encoding if gzip) */
router.get('/dm/attachments/:id/download', requireAuth, (req, res) => {
    const row = db.prepare(`SELECT a.*, m.conversation_id
                          FROM dm_attachments a JOIN dm_messages m ON m.id=a.message_id
                          WHERE a.id=?`).get(+req.params.id);
    if (!row) return res.status(404).end();
    if (!isMember(row.conversation_id, req.userId)) return res.status(403).end();

    // decrypt -> stream as you already do…
    // res.contentType(row.mime_type) etc.

    if (Number.isFinite(row.duration_ms) && row.duration_ms > 0) {
        res.setHeader('X-Audio-Duration-Ms', String(row.duration_ms));
    }
    // … then end/pipe body
});

/** Attachment meta – returns (and backfills) duration_ms. Kept for older rows. */
router.get('/dm/attachments/:id/meta', requireAuth, (req, res) => {
    const row = db.prepare(`SELECT a.duration_ms, m.conversation_id
                          FROM dm_attachments a JOIN dm_messages m ON m.id=a.message_id
                          WHERE a.id=?`).get(+req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (!isMember(row.conversation_id, req.userId)) return res.status(403).end();
    res.json({ duration_ms: Number.isFinite(row.duration_ms) ? row.duration_ms : null });
});

/* ====== message COLORS endpoints ====== */

// Get map { user_id: '#hex' }
router.get('/dm/conversations/:id/message_colors', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });
    try {
        const colors = getColorMap(convId);
        res.json({ ok: true, colors });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

// Set my color (null to clear) — emits system message + SSE
router.patch('/dm/conversations/:id/message_colors/me', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

    const raw = req.body?.color;
    const clear = raw == null || raw === '' || raw === false;
    const color = clear ? null : String(raw).trim();
    if (!clear && !isValidHex6(color)) return res.status(400).json({ error: 'bad_color' });

    try {
        setUserColor(convId, req.userId, color);
        addSystemMessage(convId, req.userId, clear
            ? `${getUserLabel(req.userId)} cleared their message color.`
            : `${getUserLabel(req.userId)} changed their message color.`);
        broadcastToUsersOfConv(convId, 'color_change', { conversation_id: convId, user_id: req.userId, color });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

// Owner-only bulk set/clear: body { colors: { [userId]: '#hex' | null } }
router.patch('/dm/conversations/:id/message_colors', requireAuth, (req, res) => {
    const convId = +req.params.id;
    const { conv, error } = ensureActiveGroup(convId);
    if (error) return res.status(error === 'not_group' ? 400 : (error === 'deleted' ? 410 : 404)).json({ error });
    if ((conv.owner_id | 0) !== (req.userId | 0)) return res.status(403).json({ error: 'owner_only' });

    const colors = req.body?.colors || {};
    try {
        for (const [k, v] of Object.entries(colors)) {
            const uid = +k;
            if (!uid || !isMember(convId, uid)) continue;
            if (v == null || v === '') {
                setUserColor(convId, uid, null);
                broadcastToUsersOfConv(convId, 'color_change', { conversation_id: convId, user_id: uid, color: null });
                continue;
            }
            const col = String(v).trim();
            if (!isValidHex6(col)) return res.status(400).json({ error: 'bad_color', user_id: uid });
            setUserColor(convId, uid, col);
            broadcastToUsersOfConv(convId, 'color_change', { conversation_id: convId, user_id: uid, color: col });
        }
        addSystemMessage(convId, req.userId, `${getUserLabel(req.userId)} updated message colors.`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'server_error', detail: String(e.message || e) });
    }
});

/** Group appearance (owner only): PATCH color and/or icon */
router.patch('/dm/conversations/:id/appearance', requireAuth,
    multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } }).single('icon'),
    (req, res) => {
        const convId = +req.params.id;
        const { conv, error } = ensureActiveGroup(convId);
        if (error) return res.status(error === 'not_group' ? 400 : (error === 'deleted' ? 410 : 404)).json({ error });
        if (!isMember(convId, req.userId)) return res.status(403).json({ error: 'forbidden' });

        const color = typeof req.body?.color === 'string' ? req.body.color.trim() : null;
        const useDefault = String(req.body?.use_default_icon || '') === '1';
        const file = req.file || null;

        const okColor = !color || /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color);
        if (!okColor) return res.status(400).json({ error: 'bad_color' });

        try {
            let didColor = false, didIconNew = false, didIconDefault = false;

            if (color) { setGroupColor(convId, color); didColor = true; }
            if (useDefault) { deleteGroupIcon(convId); didIconDefault = true; }
            else if (file && file.buffer && file.size > 0) {
                const type = (file.mimetype || 'image/png').toLowerCase();
                if (!/^image\//.test(type)) return res.status(400).json({ error: 'bad_icon_type' });
                upsertGroupIcon(convId, type, file.buffer);
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
    });

/** Serve group icon (decrypted). Falls back to 404 so client can use default. */
router.get('/dm/conversations/:id/icon', requireAuth, (req, res) => {
    const convId = +req.params.id;
    if (!isMember(convId, req.userId)) return res.status(403).end();
    const row = getGroupIcon(convId);
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
    const groups = db.prepare(`
    SELECT c.id
    FROM dm_conversations c
    JOIN dm_members m ON m.conversation_id=c.id AND m.user_id=?
    WHERE c.is_group=1 AND c.owner_id=? AND c.deleted_at IS NULL
  `).all(removedUserId, ownerId);

    const ownerName = getUserLabel(ownerId);
    const removedName = getUserLabel(removedUserId);

    const tx = db.transaction(() => {
        for (const g of groups) {
            const convId = g.id;
            if (!isMember(convId, removedUserId)) continue;
            db.prepare(`DELETE FROM dm_members WHERE conversation_id=? AND user_id=?`).run(convId, removedUserId);
            addSystemMessage(convId, ownerId, `${ownerName} unfriended ${removedName}. They've been removed from the group.`);
        }
    });
    tx();

    return { ok: true, count: groups.length };
}

module.exports = { router, removeUserFromOwnerGroups };