// server.js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { issueCsrfToken } = require('./security');
const { db, migrate } = require('./db');
const { requireAuth } = require('./routes-auth');
const dm = require('./routes-dm');

const WEB_ROOT = path.join(__dirname, '..'); // repo root
migrate();

const app = express();

app.set('trust proxy', false);

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

/* ---------------- middleware ---------------- */
app.get('/api/_routes', (req, res) => res.json(listRoutes(app)));

app.use(express.static(WEB_ROOT, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js')) res.type('application/javascript; charset=utf-8');
        if (filePath.endsWith('.css')) res.type('text/css; charset=utf-8');
    }
}));

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use(cors({
    origin: ['http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-User-Id', 'Range'],
    exposedHeaders: ['X-Audio-Duration-Ms', 'Accept-Ranges', 'Content-Range']
}));

/* ---------------- dev routes (optional) ---------------- */
try { app.use('/api/dev', require('./routes-dev').router); } catch { }

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

/* ---------------- DM router BEFORE CSRF (multipart form doesn’t send CSRF) ---------------- */
app.use('/api', dm.router);

/* ---------------- CSRF ---------------- */
app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const cookieToken = req.cookies.csrf;
    const headerToken = req.get('x-csrf-token');
    if (!cookieToken || !headerToken || cookieToken !== headerToken) {
        return res.status(403).json({ error: 'csrf' });
    }
    next();
});

app.get('/api/csrf', (req, res) => {
    const t = issueCsrfToken();
    res.cookie('csrf', t, { httpOnly: false, sameSite: 'lax', secure: false });
    res.json({ token: t });
});

/* ---------------- rate limit ---------------- */
app.set('trust proxy', true);
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
    }
}));

app.use('/api/auth', require('./routes-auth').router);
app.use('/api', require('./routes-saves').router);
app.use('/api', require('./routes-social').router);
app.use('/api', require('./routes-users').router);
app.use('/api', require('./routes-friends').router);
app.use('/api/admin', require('./routes-admin').router);

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

app.get('/api/dm/attachments/:id/download', (req, res) => {
    const row = db.prepare(
        'SELECT filepath AS path, filename, mime_type FROM attachments WHERE id=? LIMIT 1'
    ).get(req.params.id);
    if (!row) return res.sendStatus(404);

    const filePath = path.resolve(row.path);
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    const mime = row.mime_type || mimeTypes.lookup(row.filename) || 'application/octet-stream';

    if (range) {
        const [s, e] = range.replace(/bytes=/, '').split('-');
        const start = parseInt(s, 10);
        const end = e ? parseInt(e, 10) : stat.size - 1;
        res.status(206).set({
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': (end - start + 1),
            'Content-Type': mime
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.set({
            'Accept-Ranges': 'bytes',
            'Content-Length': stat.size,
            'Content-Type': mime
        });
        fs.createReadStream(filePath).pipe(res);
    }
});


/* ---------------- helper to create or reuse a 1:1 DM ----------------
   This proxies to POST /api/dm/conversations so keys get created the same way.
   NOTE: routes-dm already exposes POST /api/dm/with/:slug; this remains for compatibility. */
app.post('/api/dm/with/:slug', requireAuth, (req, res, next) => {
    const slug = String(req.params.slug || '');
    const other = db.prepare(
        `SELECT id FROM users WHERE lower(username)=lower(?) OR lower(first_username)=lower(?) LIMIT 1`
    ).get(slug, slug);
    if (!other) return res.status(404).json({ error: 'user_not_found' });
    if (other.id === req.userId) return res.status(400).json({ error: 'self' });

    // Reuse the DM router’s /dm/conversations handler so conv key is created
    req.body = { user_ids: [req.userId, other.id] };
    req.url = '/dm/conversations';
    req.method = 'POST';
    return dm.router.handle(req, res, next);
});

/* ---------------- background maintenance ---------------- */
/** Purge disbanded groups after 30 days. Safe to run frequently. */
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
// Run once on boot and then every 6 hours
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
