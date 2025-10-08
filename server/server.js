// server.js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const mimeTypes = require('mime-types');

const { issueCsrfToken } = require('./security');
const { db, migrate } = require('./db');
const { requireAuth } = require('./routes-auth');
const dm = require('./routes-dm');

const WEB_ROOT = path.join(__dirname, '..'); // repo root
const UPLOADS_ROOT = path.join(__dirname, 'uploads');
const EMOJI_DIR = path.join(UPLOADS_ROOT, 'custom-emojis');
try { fs.mkdirSync(EMOJI_DIR, { recursive: true }); } catch { }

migrate();

const app = express();
app.set('trust proxy', true);

/* ---------------- helpers ---------------- */
function listRoutes(app) {
    const out = [];
    const stack = app._router?.stack || [];
    for (const layer of stack) {
        if (layer.route) {
            out.push({ base: '', path: layer.route.path, methods: Object.keys(layer.route.methods) });
        } else if (layer.name === 'router' && layer.handle?.stack) {
            const mount = layer.regexp?.toString() || '';
            for (const r of layer.handle.stack) {
                if (r.route) out.push({ base: mount, path: r.route.path, methods: Object.keys(r.route.methods) });
            }
        }
    }
    return out;
}

/* ---------------- dev helpers ---------------- */
if (process.env.NODE_ENV !== 'production') {
    app.get('/api/_routes', (req, res) => res.json(listRoutes(app)));
    try { app.use('/api/dev', require('./routes-dev').router); } catch { }
}

/* ---------------- static (site root) ---------------- */
app.use(express.static(WEB_ROOT, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js')) res.type('application/javascript; charset=utf-8');
        if (filePath.endsWith('.css')) res.type('text/css; charset=utf-8');
    }
}));

/* ---------------- security headers ---------------- */
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false, // we set COEP/COOP manually below
}));

/* ---------------- parsers ---------------- */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/* ---------------- CORS ---------------- */
app.use(cors({
    origin: ['http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-User-Id', 'Range'],
    exposedHeaders: ['X-Audio-Duration-Ms', 'Accept-Ranges', 'Content-Range'],
}));

/* ---------------- base info ---------------- */
app.get('/api', (req, res) => {
    res.json({
        ok: true,
        name: 'DailyPlea API (PoC)',
        now: new Date().toISOString(),
        endpoints: [
            '/api/csrf',
            '/api/auth/register',
            '/api/auth/login',
            '/api/auth/logout',
            '/api/auth/me',
            '/api/auth/2fa/enable',
            '/api/auth/2fa/verify',
            '/api/save',
            '/api/pleas/:id/comments',
            '/api/comments/:id/vote',
            '/api/pleas/:id/vote',
            '/api/pleas/:id/votes',
            '/api/plealist',
            '/api/plealist/sync',
            '/api/plealist/toggle'
        ]
    });
});

/* ---------------- DM router BEFORE CSRF (multipart forms) ---------------- */
app.use('/api', dm.router);

/* ---------------- CSRF (double-submit cookie) ---------------- */
app.use((req, res, next) => {
    // Set COOP/COEP here; keep COEP strict, since we serve our own assets
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const cookieToken = req.cookies.csrf;
    const headerToken = req.get('x-csrf-token');
    const ok = cookieToken && headerToken && cookieToken === headerToken;
    if (!ok) {
        console.warn('[csrf] BLOCKED', {
            path: req.path,
            method: req.method,
            hasCookie: !!cookieToken,
            hasHeader: !!headerToken,
            match: (cookieToken && headerToken) ? (cookieToken === headerToken) : false
        });
        return res.status(403).json({ error: 'csrf' });
    }
    next();
});

app.get('/api/csrf', (req, res) => {
    const t = issueCsrfToken();
    res.cookie('csrf', t, {
        httpOnly: false,   // readable by client for double-submit
        sameSite: 'strict',
        secure: true       // set true in HTTPS prod
    });
    res.json({ token: t });
});

/* ---------------- rate limit (auth endpoints) ---------------- */
const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skipFailedRequests: true,
});
app.use('/api/auth', authLimiter);

/* ---------------- health ---------------- */
app.get('/health', (req, res) => res.json({ ok: true }));

/* ---------------- static / other routers ---------------- */
app.use('/web', express.static('web', {
    setHeaders: (res, p) => {
        if (p.endsWith('.js') || p.endsWith('.mjs')) res.setHeader('Content-Type', 'application/javascript');
        if (p.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
    }
}));

app.use('/api/auth', require('./routes-auth').router);
app.use('/api', require('./routes-saves').router);
app.use('/api', require('./routes-social').router);
app.use('/api', require('./routes-users').router);
app.use('/api', require('./routes-friends').router);
app.use('/api/admin', require('./routes-admin').router);

/* Serve custom emojis at the path emitted by publicEmojiURL('/media/custom-emojis/...') */
app.use('/media/custom-emojis', express.static(EMOJI_DIR, {
    setHeaders: (res, p) => {
        const mt = mimeTypes.lookup(p) || 'application/octet-stream';
        res.setHeader('Content-Type', mt);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
}));

/* ---------------- pretty routes for web shells ---------------- */
app.get('/pleas/:id', (req, res, next) => {
    const f = path.join(WEB_ROOT, 'pleas', `${req.params.id}.html`);
    res.sendFile(f, err => err ? next() : undefined);
});
app.get('/user/:slug/friends', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const f = path.join(WEB_ROOT, 'web', 'user-friends.html');
    res.sendFile(f, err => err ? next() : undefined);
});
app.get('/user/:slug/edit', (req, res, next) => {
    const f = path.join(WEB_ROOT, 'web', 'user.html');
    res.sendFile(f, err => err ? next() : undefined);
});
app.get('/user/:slug/messages', (req, res, next) => {
    const f = path.join(WEB_ROOT, 'web', 'messages.html');
    res.sendFile(f, err => err ? next() : undefined);
});
app.get('/user/:slug', (req, res, next) => {
    const f = path.join(WEB_ROOT, 'web', 'user-view.html');
    res.sendFile(f, err => err ? next() : undefined);
});

/* ---------------- helper to create or reuse a 1:1 DM ----------------
   Proxies to POST /api/dm/conversations so keys get created the same way. */
app.post('/api/dm/with/:slug', requireAuth, (req, res, next) => {
    const slug = String(req.params.slug || '');
    const other = db.prepare(
        `SELECT id FROM users WHERE lower(username)=lower(?) OR lower(first_username)=lower(?) LIMIT 1`
    ).get(slug, slug);
    if (!other) return res.status(404).json({ error: 'user_not_found' });
    if (other.id === req.userId) return res.status(400).json({ error: 'self' });

    // Reuse the DM router’s handler
    req.body = { user_ids: [req.userId, other.id] };
    req.url = '/dm/conversations';
    req.method = 'POST';
    return dm.router.handle(req, res, next);
});

/* ---------------- background maintenance ---------------- */
function sweepDeletedGroups() {
    try {
        const r = db.prepare(
            `DELETE FROM dm_deleted_groups WHERE datetime(deleted_at) < datetime('now', '-30 days')`
        ).run();
        if (r.changes) console.log(`[dm] Purged ${r.changes} expired deleted groups`);
    } catch (e) {
        console.warn('[dm] sweepDeletedGroups error:', e?.message || e);
    }
}
sweepDeletedGroups();
setInterval(sweepDeletedGroups, 6 * 60 * 60 * 1000);

/* ---------------- error handler ---------------- */
app.use((err, req, res, next) => {
    console.error('UNCAUGHT', req.method, req.url, '\n', err);
    if (res.headersSent) return next(err);
    res.status(500).json({
        error: 'server_error',
        route: `${req.method} ${req.path}`,
        detail: String((err && err.message) || err)
    });
});

/* ---------------- start ---------------- */
const port = +(process.env.PORT || 3000);
app.listen(port, () => console.log('Server on http://localhost:' + port));
