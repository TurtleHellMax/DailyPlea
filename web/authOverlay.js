// web/authOverlay.js
(() => {
    'use strict';

    const state = {
        apiBase: 'http://localhost:3000/api',
        csrf: null,
        overlay: null,
    };

    // ---------- tiny helpers ----------
    const byId = (id) => document.getElementById(id);

    async function fetchCsrf() {
        const r = await fetch(state.apiBase.replace('/api', '') + '/api/csrf', { credentials: 'include' });
        const j = await r.json();
        state.csrf = j.token;
        return j.token;
    }

    // replace your api() with this
    async function api(path, opts = {}) {
        const method = (opts.method || 'GET').toUpperCase();
        const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
        if (method !== 'GET' && !headers['x-csrf-token']) {
            if (!state.csrf) await fetchCsrf();
            headers['x-csrf-token'] = state.csrf;
        }
        const res = await fetch(state.apiBase + path, {
            method, credentials: 'include', headers, body: opts.body
        });

        // Accept empty/204 responses
        const text = await res.text();
        let data = {};
        if (text) {
            try { data = JSON.parse(text); } catch { /* fallback to {} */ }
        }
        if (!res.ok) throw (data || { error: 'request_failed', status: res.status });

        return data;
    }

    function msg(t = '') {
        const n = byId('dp-msg');
        if (n) n.textContent = t;
    }

    // ---------- overlay UI ----------
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
            setActiveTab(btnReg, btnLogin);
            renderRegister();
        } else {
            setActiveTab(btnLogin, btnReg);
            renderLogin();
        }
    }

    // ---------- views ----------
    function renderLogin() {
        const c = byId('dp-content');
        if (!c) return;
        c.innerHTML = `
      <h2 style="margin:0 0 8px">Welcome back</h2>
      <label>Email or phone</label>
      <input id="dp-id" autocomplete="username">
      <label>Password</label>
      <input id="dp-pw" type="password" autocomplete="current-password">
      <div id="dp-totp-row" style="display:none">
        <label>2FA code</label>
        <input id="dp-totp" placeholder="123456" inputmode="numeric" pattern="\\d*">
      </div>
      <button id="dp-login" style="margin-top:10px">Login</button>
      <div class="muted" style="margin-top:6px"><a href="#" id="dp-reset">Forgot password?</a></div>
    `;

        byId('dp-login').onclick = async () => {
            msg('');
            const identifier = byId('dp-id').value.trim();
            const password = byId('dp-pw').value;
            const totp = (byId('dp-totp')?.value || '').trim();

            try {
                await fetchCsrf();
                const body = { identifier, password };
                if (totp) body.totp = totp;
                // in renderLogin() submit handler, replace the success branch:
                await api('/auth/login', { method: 'POST', body: JSON.stringify(body) });
                msg('Logged in.');
                state.overlay.style.display = 'none';

                // run post-login sync, but don't let it break login UX
                Promise.resolve()
                    .then(() => (window.DP && DP.syncAfterLogin) ? DP.syncAfterLogin() : null)
                    .catch(err => console.warn('post-login sync failed:', err));

                if (window.DP && DP.syncAfterLogin) DP.syncAfterLogin();
            } catch (e) {
                if (e && e.error === 'totp_required') {
                    byId('dp-totp-row').style.display = '';
                    msg('Enter your 2FA code.');
                } else {
                    msg(e?.error || 'Login failed');
                }
            }
        };

        byId('dp-reset').onclick = async (ev) => {
            ev.preventDefault();
            msg('');
            try {
                await fetchCsrf();
                await api('/auth/password/reset/request', {
                    method: 'POST',
                    body: JSON.stringify({ identifier: byId('dp-id').value.trim() })
                });
                msg('If the account exists, a reset message was sent (Dev Mailbox).');
            } catch (e) {
                msg(e?.error || 'Reset failed');
            }
        };
    }

    function renderRegister() {
        const c = byId('dp-content');
        if (!c) return;
        c.innerHTML = `
      <h2 style="margin:0 0 8px">Create account</h2>
      <label>Email</label>
      <input id="dp-email" autocomplete="email">
      <label>Phone</label>
      <input id="dp-phone" placeholder="+15555550123">
      <label>Password</label>
      <input id="dp-pw2" type="password" autocomplete="new-password">
      <button id="dp-reg" style="margin-top:10px">Register</button>
    `;

        byId('dp-reg').onclick = async () => {
            msg('');
            const email = byId('dp-email').value.trim() || null;
            const phone = byId('dp-phone').value.trim() || null;
            const password = byId('dp-pw2').value;

            try {
                await fetchCsrf();
                await api('/auth/register', {
                    method: 'POST',
                    body: JSON.stringify({ email, phone, password })
                });

                // carry over local save to the account (if you have guest progress)
                try {
                    const localSave = JSON.parse(localStorage.getItem('dp_save') || 'null');
                    if (localSave) {
                        await api('/saves/sync', { method: 'POST', body: JSON.stringify({ localSave }) });
                    }
                } catch { }

                msg('Account created. You are signed in.');
                state.overlay.style.display = 'none';
                if (window.DP && DP.syncAfterLogin) DP.syncAfterLogin();
            } catch (e) {
                msg(e?.error || 'Register failed');
            }
        };
    }

    // ---------- exports ----------
    window.DP = window.DP || {};
    window.DP.init = (opts = {}) => { if (opts.apiBase) state.apiBase = opts.apiBase; };
    window.DP.openAuth = () => showOverlay('login');
    // you can override this elsewhere; provided here so callers can await it safely
    window.DP.syncAfterLogin = window.DP.syncAfterLogin || (async () => { });

    // Optional convenience: auto-bind a button with id="dp-login-btn"
    window.addEventListener('DOMContentLoaded', () => {
        const btn = document.getElementById('dp-login-btn');
        if (btn) btn.addEventListener('click', () => showOverlay('login'));
    });
})();
