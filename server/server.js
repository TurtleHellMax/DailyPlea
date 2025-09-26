require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { issueCsrfToken } = require('./security');
const path = require('path');
const WEB_ROOT = path.join(__dirname, '..'); // repo root

const { db, migrate } = require('./db');
migrate();

const app = express();
function listRoutes(app) {
    const out = [];
    const stack = app._router?.stack || [];
    for (const layer of stack) {
        if (layer.route) {
            out.push({ base: '', path: layer.route.path, methods: Object.keys(layer.route.methods) });
        } else if (layer.name === 'router' && layer.handle?.stack) {
            // mounted router (e.g. at /api)
            const mount = layer.regexp?.toString() || '';
            for (const r of layer.handle.stack) {
                if (r.route) {
                    out.push({
                        base: mount, path: r.route.path,
                        methods: Object.keys(r.route.methods)
                    });
                }
            }
        }
    }
    return out;
}
app.get('/api/_routes', (req, res) => res.json(listRoutes(app)));
app.use(express.static(WEB_ROOT, {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js')) res.type('application/javascript; charset=utf-8');
        if (filePath.endsWith('.css')) res.type('text/css; charset=utf-8');
    }
}));
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(cors({
    origin: ['http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true
}));
app.use('/api/dev', require('./routes-dev').router);

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

// CSRF middleware (double-submit). Allow GET/HEAD, protect POST/PUT/PATCH/DELETE
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



app.set('trust proxy', true); // keep this

const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: ipKeyGenerator,   // <-- use library helper
    skipFailedRequests: true,
});

app.use('/api/auth', authLimiter);


app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/web', express.static('web', {
    setHeaders: (res, p) => {
        if (p.endsWith('.js') || p.endsWith('.mjs')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));
app.use('/api/auth', require('./routes-auth').router);
app.use('/api', require('./routes-saves').router);
app.use('/api', require('./routes-social').router);
app.use('/api/admin', require('./routes-admin').router);

// (optional) if you want /pleas/78 to work without a .html extension:
app.get('/pleas/:id', (req, res, next) => {
    const f = path.join(WEB_ROOT, 'pleas', `${req.params.id}.html`);
    res.sendFile(f, err => err ? next() : undefined);
});

const port = +(process.env.PORT || 3000);
app.listen(port, () => console.log('Server on http://localhost:' + port));

app.use((err, req, res, next) => {
    console.error('UNCAUGHT', req.method, req.url, '\n', err);
    if (res.headersSent) return next(err);
    res.status(500).json({
        error: 'server_error',
        route: `${req.method} ${req.path}`,
        detail: String(err && err.message || err)
    });
});

const social = require('./routes-social');
console.log('routes-social keys:', Object.keys(social)); // should include 'router'
app.use('/api', social.router);