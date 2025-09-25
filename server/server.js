require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { db, migrate } = require('./db');
const { issueCsrfToken } = require('./security');


migrate();


const app = express();
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5500', credentials: true }));

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


// Basic rate limits
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 100 });
app.use('/api/auth', authLimiter);


app.get('/health', (req, res) => res.json({ ok: true }));


app.use('/api/auth', require('./routes-auth').router);
app.use('/api', require('./routes-saves').router);
app.use('/api', require('./routes-social').router);
app.use('/api/admin', require('./routes-admin').router);


const port = +(process.env.PORT || 3000);
app.listen(port, () => console.log('Server on http://localhost:' + port));