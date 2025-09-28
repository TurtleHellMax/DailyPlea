// web/authOverlay.js
(() => {
    'use strict';

    const state = {
        apiBase: 'http://localhost:3000/api',
        csrf: null,
        overlay: null,
    };

    /* ===================== UTIL & DEBUG ===================== */

    const byId = (id) => document.getElementById(id);

    function msg(t = '') {
        const n = byId('dp-msg');
        if (n) n.textContent = t;
    }

    function snippet(s, n = 160) {
        if (!s) return '';
        const t = String(s).replace(/\s+/g, ' ').trim();
        return t.length > n ? t.slice(0, n) + '…' : t;
    }

    function showSpecificError(action, err) {
        const line =
            `${action} failed → ${err.method || 'GET'} ${err.path || '(unknown)'} ` +
            `[${err.status ?? 'no-status'}] ` +
            `${err.code || err.error || err.statusText || 'unknown'}` +
            (err.detail ? ` · ${snippet(err.detail, 140)}` : '');
        msg(line);

        console.groupCollapsed(`❌ ${action} failed`);
        console.error('Error object:', err);
        console.error('Request:', { method: err.method, url: err.url, headers: err.reqHeaders, body: err.reqBody });
        console.error('Response:', { status: err.status, statusText: err.statusText, headers: err.resHeaders, data: err.data, text: err.text });
        console.groupEnd();
    }

    /* ===================== CLIENT-SIDE VALIDATION & SANITIZERS ===================== */

    // Username: 3–24 alnum + underscore
    const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;
    function validateUsername(u) {
        const username = String(u || '').trim();
        if (!username) return { ok: false, reason: 'Username is required.' };
        if (!USERNAME_RE.test(username)) {
            return { ok: false, reason: 'Username must be 3–24 chars: letters, numbers, underscore.' };
        }
        return { ok: true, username };
    }

    // Password policy: >6 and <32; one capital; one number; one symbol
    function validatePassword(pw) {
        const s = String(pw || '');
        const reasons = [];
        if (!(s.length > 6 && s.length < 32)) reasons.push('7–31 characters');
        if (!/[A-Z]/.test(s)) reasons.push('at least one capital letter');
        if (!/[0-9]/.test(s)) reasons.push('at least one number');
        if (!/[^A-Za-z0-9]/.test(s)) reasons.push('at least one symbol');
        return { ok: reasons.length === 0, reasons };
    }

    // Email / phone sanitizers (mirror server rules)
    function sanitizeEmail(x) {
        const s = String(x || '').trim();
        return s ? s : '';
    }
    function isEmail(x) {
        return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(x || ''));
    }
    function sanitizePhone(x) {
        if (!x) return '';
        let s = String(x).trim();
        const hasPlus = s.startsWith('+');
        s = s.replace(/[^\d+]/g, '');
        if (hasPlus) s = '+' + s.replace(/[+]/g, '');
        else s = s.replace(/[+]/g, '');
        return s;
    }
    function isPhone(x) {
        return /^\+?[0-9]{7,15}$/.test(String(x || ''));
    }

    /* ===================== CSRF + API WRAPPER ===================== */

    async function fetchCsrf() {
        const url = state.apiBase.replace('/api', '') + '/api/csrf';
        const r = await fetch(url, { credentials: 'include' }).catch((e) => {
            throw {
                name: 'NetworkError',
                code: 'csrf_network_error',
                message: 'Failed to reach /api/csrf',
                method: 'GET',
                url,
                path: '/api/csrf',
                detail: String(e?.message || e),
            };
        });

        let text = '';
        try { text = await r.text(); } catch { }
        let j = {};
        try { j = text ? JSON.parse(text) : {}; } catch { }
        if (!r.ok || !j.token) {
            throw {
                name: 'CsrfError',
                code: 'csrf_bad_response',
                message: 'Unexpected CSRF response',
                method: 'GET',
                url,
                path: '/api/csrf',
                status: r.status,
                statusText: r.statusText,
                text,
                data: j,
            };
        }
        state.csrf = j.token;
        return j.token;
    }

    async function api(path, opts = {}) {
        const method = (opts.method || 'GET').toUpperCase();
        const url = state.apiBase + path;

        const headers = Object.assign({}, opts.headers || {});
        if (opts.body && !headers['content-type']) {
            headers['content-type'] = 'application/json';
        }

        if (method !== 'GET' && !headers['x-csrf-token']) {
            if (!state.csrf) await fetchCsrf();
            headers['x-csrf-token'] = state.csrf;
        }

        const reqInfo = { method, url, reqHeaders: headers, reqBody: opts.body, path };

        let res;
        try {
            res = await fetch(url, { method, credentials: 'include', headers, body: opts.body });
        } catch (e) {
            throw {
                ...reqInfo,
                name: 'NetworkError',
                code: 'network_error',
                message: `Network error calling ${method} ${path}`,
                detail: String(e?.message || e),
            };
        }

        let text = '';
        try { text = await res.text(); } catch { }
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { }

        if (!res.ok) {
            const code = (data && (data.error || data.code)) || undefined;
            const message = (data && (data.message || data.msg)) || undefined;

            throw {
                ...reqInfo,
                name: 'HttpError',
                code: code || 'http_error',
                error: code,
                message: message || `HTTP ${res.status} on ${path}`,
                status: res.status,
                statusText: res.statusText,
                data,
                text,
                resHeaders: Object.fromEntries(res.headers.entries()),
                detail: snippet(text || message, 300),
            };
        }

        return (text ? (data || {}) : {});
    }

    /* ===================== OVERLAY UI ===================== */

    function ensureOverlay() {
        if (state.overlay) return state.overlay;

        const el = document.createElement('div');
        el.id = 'dp-overlay';
        el.style.cssText = 'position:fixed;inset:0;display:none;z-index:9999;';
        el.innerHTML = `
      <div class="dp-backdrop" style="position:absolute;inset:0;background:rgba(0,0,0,.6)"></div>
      <div class="dp-modal" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(92vw,420px);background:#121212;color:#eee;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.5);padding:16px 16px 12px">
        <button class="dp-close" title="Close" style="position:absolute;right:10px;top:8px;background:none;border:none;color:#aaa;font-size:20px;cursor:pointer">×</button>
        <div id="dp-tabs" style="display:flex;gap:8px;margin-bottom:10px">
          <button data-tab="login" class="active" style="flex:1;padding:8px;border:none;border-radius:8px;background:#3b82f6;color:#fff;cursor:pointer">Login</button>
          <button data-tab="register" style="flex:1;padding:8px;border:none;border-radius:8px;background:#1f2937;color:#cbd5e1;cursor:pointer">Register</button>
        </div>
        <div id="dp-content"></div>
        <div class="muted" id="dp-msg" style="color:#fca5a5;min-height:1.2em;margin-top:8px"></div>
      </div>
    `;
        document.body.appendChild(el);
        state.overlay = el;

        const close = () => { el.style.display = 'none'; };
        el.querySelector('.dp-backdrop').addEventListener('click', close);
        el.querySelector('.dp-close').addEventListener('click', close);

        const [btnLogin, btnReg] = el.querySelectorAll('#dp-tabs button');
        btnLogin.addEventListener('click', () => { setActiveTab(btnLogin, btnReg); renderLogin(); });
        btnReg.addEventListener('click', () => { setActiveTab(btnReg, btnLogin); renderRegister(); });

        return el;
    }

    function setActiveTab(activeBtn, otherBtn) {
        activeBtn.classList.add('active');
        activeBtn.style.background = '#3b82f6';
        activeBtn.style.color = '#fff';
        otherBtn.classList.remove('active');
        otherBtn.style.background = '#1f2937';
        otherBtn.style.color = '#cbd5e1';
        msg('');
    }

    function showOverlay(startTab = 'login') {
        ensureOverlay();
        state.overlay.style.display = 'block';
        const [btnLogin, btnReg] = state.overlay.querySelectorAll('#dp-tabs button');
        if (startTab === 'register') {
            setActiveTab(btnReg, btnLogin); renderRegister();
        } else {
            setActiveTab(btnLogin, btnReg); renderLogin();
        }
    }

    /* ===================== VIEWS ===================== */

    function renderLogin() {
        const c = byId('dp-content');
        if (!c) return;
        c.innerHTML = `
      <h2 style="margin:0 0 8px">Welcome back</h2>
      <label>Email or phone</label>
      <input id="dp-id" autocomplete="username" placeholder="name@example.com or +15555550123">
      <label>Password</label>
      <input id="dp-pw" type="password" autocomplete="current-password">
      <div id="dp-totp-row" style="display:none">
        <label>2FA code</label>
        <div style="display:flex;gap:8px">
          <input id="dp-totp" inputmode="numeric" placeholder="123456" style="flex:1">
          <button id="dp-sendcode" type="button" title="Send code to your email/phone" style="white-space:nowrap">Send code</button>
        </div>
      </div>
      <button id="dp-login" style="margin-top:10px">Login</button>
      <div class="muted" style="margin-top:6px"><a href="#" id="dp-reset">Forgot password?</a></div>
    `;

        const idInput = byId('dp-id');
        idInput.addEventListener('blur', () => {
            const raw = idInput.value.trim();
            if (!raw) return;
            if (raw.includes('@')) {
                const e = sanitizeEmail(raw);
                idInput.value = e;
            } else {
                const p = sanitizePhone(raw);
                idInput.value = p;
            }
        });

        const show2fa = (hint) => {
            const row = byId('dp-totp-row'); if (row) row.style.display = '';
            msg(hint || 'Enter your 2FA code.');
        };

        byId('dp-sendcode').onclick = async () => {
            try {
                await fetchCsrf();
                msg('Check Dev Mailbox for the code.');
            } catch (e) {
                msg('Could not send code.');
            }
        };

        byId('dp-login').onclick = async () => {
            msg('');
            const rawId = idInput.value.trim();
            const password = byId('dp-pw').value;
            const totp = (byId('dp-totp')?.value || '').trim();

            // sanitize/validate identifier like the server
            let identifier = '';
            if (rawId.includes('@')) {
                const e = sanitizeEmail(rawId);
                if (!isEmail(e)) { msg('Invalid email.'); return; }
                identifier = e;
            } else {
                const p = sanitizePhone(rawId);
                if (!isPhone(p)) { msg('Invalid phone number.'); return; }
                identifier = p;
            }

            try {
                await fetchCsrf();
                const body = { identifier, password };
                if (totp) body.totp = totp;

                await api('/auth/login', { method: 'POST', body: JSON.stringify(body) });

                msg('Logged in.');
                state.overlay.style.display = 'none';
                Promise.resolve((window.DP && DP.syncAfterLogin) ? DP.syncAfterLogin() : null)
                    .catch(err => console.warn('post-login sync failed:', err));
            } catch (e) {
                if (e?.error === 'totp_required') { show2fa('Enter your authenticator app code.'); return; }
                if (e?.error === 'totp_invalid') { show2fa('That authenticator code was invalid.'); return; }
                if (e?.error === 'email_otp_required') { show2fa('We sent a 6-digit code to your email. Enter it above.'); return; }
                if (e?.error === 'email_otp_invalid') { show2fa('That 6-digit code was invalid. Try again.'); return; }
                if (e?.error === 'email_otp_expired') { show2fa('That code expired. Click “Send code” and try again.'); return; }
                if (e?.error) msg(`Login failed: ${e.error}`); else msg('Login failed');
            }
        };

        byId('dp-reset').onclick = async (ev) => {
            ev.preventDefault();
            try {
                await fetchCsrf();
                await api('/auth/password/reset/request', {
                    method: 'POST',
                    body: JSON.stringify({ identifier: idInput.value.trim() })
                });
                msg('Reset link sent to Dev Mailbox.');
            } catch {
                msg('Reset failed.');
            }
        };
    }

    function renderRegister() {
        const c = byId('dp-content');
        if (!c) return;
        c.innerHTML = `
      <h2 style="margin:0 0 8px">Create account</h2>
      <label>Username <span class="muted" style="font-weight:normal;color:#94a3b8">(3–24 letters, numbers, _)</span></label>
      <input id="dp-username" placeholder="your_handle" autocomplete="off">
      <label>Email</label>
      <input id="dp-email" autocomplete="email" placeholder="name@example.com">
      <label>Phone</label>
      <input id="dp-phone" placeholder="+15555550123" autocomplete="tel">
      <label>Password</label>
      <input id="dp-pw2" type="password" autocomplete="new-password" placeholder="Min 7, < 32, 1 capital, 1 number, 1 symbol">
      <button id="dp-reg" style="margin-top:10px">Register</button>
    `;

        const inputEmail = byId('dp-email');
        const inputPhone = byId('dp-phone');

        inputEmail.addEventListener('blur', () => {
            inputEmail.value = sanitizeEmail(inputEmail.value);
        });
        inputPhone.addEventListener('blur', () => {
            inputPhone.value = sanitizePhone(inputPhone.value);
        });

        // live hint for password policy
        const pw = byId('dp-pw2');
        pw?.addEventListener('input', () => {
            const v = validatePassword(pw.value);
            if (!v.ok) {
                msg('Password needs: ' + v.reasons.join(', ') + '.');
            } else {
                msg('');
            }
        });

        byId('dp-reg').onclick = async () => {
            msg('');
            const username = byId('dp-username').value.trim();
            const emailRaw = inputEmail.value;
            const phoneRaw = inputPhone.value;
            const email = sanitizeEmail(emailRaw);
            const phone = sanitizePhone(phoneRaw);
            const password = pw.value;

            // Client-side checks
            const u = validateUsername(username);
            if (!u.ok) { msg(u.reason); return; }

            if (!email && !phone) {
                msg('Please provide an email or a phone number.'); return;
            }
            if (email && !isEmail(email)) {
                msg('Invalid email.'); return;
            }
            if (phone && !isPhone(phone)) {
                msg('Invalid phone number.'); return;
            }

            const p = validatePassword(password);
            if (!p.ok) { msg('Password needs: ' + p.reasons.join(', ') + '.'); return; }

            try {
                await fetchCsrf().catch((e) => { throw { ...e, action: 'Fetch CSRF' }; });

                await api('/auth/register', {
                    method: 'POST',
                    body: JSON.stringify({
                        username,
                        email: email || null,
                        phone: phone || null,
                        password
                    })
                }).catch((e) => { throw { ...e, action: 'Register' }; });

                // carry over local save to the account (best-effort)
                try {
                    const localSave = JSON.parse(localStorage.getItem('dp_save') || 'null');
                    if (localSave) {
                        await api('/saves/sync', {
                            method: 'POST',
                            body: JSON.stringify({ localSave })
                        }).catch((e) => { throw { ...e, action: 'Carry-over saves (sync)' }; });
                    }
                } catch (e) {
                    showSpecificError('Carry-over saves (sync)', {
                        method: 'POST',
                        path: '/saves/sync',
                        detail: String(e?.message || e),
                    });
                }

                msg('Account created. You are signed in.');
                state.overlay.style.display = 'none';
                if (window.DP && DP.syncAfterLogin) {
                    Promise
                        .resolve(DP.syncAfterLogin())
                        .catch((err) => {
                            showSpecificError('Post-register sync', {
                                method: 'POST',
                                path: '(custom sync)',
                                detail: String(err?.message || err),
                            });
                        });
                }
            } catch (e) {
                if (e?.error === 'invalid_username') { msg('Username must be 3–24 characters: letters, numbers, underscore.'); return; }
                if (e?.error === 'username_banned') { msg('That username is not allowed. Pick a different one.'); return; }
                if (e?.error === 'username_taken') { msg('That username is taken. Try another.'); return; }
                if (e?.error === 'user_exists') { msg('Email or phone already in use.'); return; }
                if (e?.error === 'weak_password') { msg('Password too weak. Use a stronger one.'); return; }
                showSpecificError(e.action || 'Register', e);
            }
        };
    }

    /* ===================== EXPORTS & AUTOBIND ===================== */

    window.DP = window.DP || {};
    window.DP.init = (opts = {}) => { if (opts.apiBase) state.apiBase = opts.apiBase; };
    window.DP.openAuth = () => showOverlay('login');
    window.DP.syncAfterLogin = window.DP.syncAfterLogin || (async () => { });

    window.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('dp-login-btn');
        if (btn) btn.addEventListener('click', () => showOverlay('login'));
    });
})();
