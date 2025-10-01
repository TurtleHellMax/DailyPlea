// web/authOverlay.js
(() => {
    'use strict';

    /* ===================== CONFIG / DEBUG ===================== */
    const DEBUG = true;

    const TAG = '[authOverlay]';
    const log = (...a) => { if (DEBUG) console.log(TAG, ...a); };
    const warn = (...a) => { if (DEBUG) console.warn(TAG, ...a); };
    const group = (name) => { if (!DEBUG) return () => { }; console.groupCollapsed(`${TAG} ${name}`); return () => console.groupEnd(); };

    const state = {
        apiBase: 'http://localhost:3000/api',
        csrf: null,
        overlay: null,
        openedAt: 0,
    };

    /* ===================== UTIL ===================== */
    const byId = (id) => document.getElementById(id);
    function msg(t = '') { const n = byId('dp-msg'); if (n) n.textContent = t; }
    function snippet(s, n = 160) { if (!s) return ''; const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; }
    function showSpecificError(action, err) {
        const line = `${action} failed → ${err.method || 'GET'} ${err.path || '(unknown)'} [${err.status ?? 'no-status'}] ${err.code || err.error || err.statusText || 'unknown'}${err.detail ? ` · ${snippet(err.detail, 140)}` : ''}`;
        msg(line);
        console.groupCollapsed(`❌ ${TAG} ${action} failed`);
        console.error('Error object:', err);
        console.error('Request:', { method: err.method, url: err.url, headers: err.reqHeaders, body: err.reqBody });
        console.error('Response:', { status: err.status, statusText: err.statusText, headers: err.resHeaders, data: err.data, text: err.text });
        console.groupEnd();
    }

    /* ===================== VALIDATION / SANITIZERS ===================== */
    const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;
    function validateUsername(u) {
        const username = String(u || '').trim();
        if (!username) return { ok: false, reason: 'Username is required.' };
        if (!USERNAME_RE.test(username)) return { ok: false, reason: 'Username must be 3–24 chars: letters, numbers, underscore.' };
        return { ok: true, username };
    }
    function validatePassword(pw) {
        const s = String(pw || ''); const reasons = [];
        if (!(s.length > 6 && s.length < 32)) reasons.push('7–31 characters');
        if (!/[A-Z]/.test(s)) reasons.push('at least one capital letter');
        if (!/[0-9]/.test(s)) reasons.push('at least one number');
        if (!/[^A-Za-z0-9]/.test(s)) reasons.push('at least one symbol');
        return { ok: reasons.length === 0, reasons };
    }
    const sanitizeEmail = (x) => String(x || '').trim();
    const isEmail = (x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(x || ''));
    function sanitizePhone(x) {
        if (!x) return '';
        let s = String(x).trim(); const hasPlus = s.startsWith('+');
        s = s.replace(/[^\d+]/g, ''); s = hasPlus ? ('+' + s.replace(/[+]/g, '')) : s.replace(/[+]/g, '');
        return s;
    }
    const isPhone = (x) => /^\+?[0-9]{7,15}$/.test(String(x || ''));

    /* ===================== CSRF + API WRAPPER ===================== */
    async function fetchCsrf() {
        const url = state.apiBase.replace('/api', '') + '/api/csrf';
        log('fetchCsrf →', url);
        const r = await fetch(url, { credentials: 'include' }).catch((e) => {
            throw { name: 'NetworkError', code: 'csrf_network_error', message: 'Failed to reach /api/csrf', method: 'GET', url, path: '/api/csrf', detail: String(e?.message || e) };
        });
        let text = ''; try { text = await r.text(); } catch { }
        let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { }
        if (!r.ok || !j.token) {
            throw { name: 'CsrfError', code: 'csrf_bad_response', message: 'Unexpected CSRF response', method: 'GET', url, path: '/api/csrf', status: r.status, statusText: r.statusText, text, data: j };
        }
        state.csrf = j.token; log('fetchCsrf ok'); return j.token;
    }
    async function api(path, opts = {}) {
        const method = (opts.method || 'GET').toUpperCase();
        const url = state.apiBase + path;
        const headers = Object.assign({}, opts.headers || {});
        if (opts.body && !headers['content-type']) headers['content-type'] = 'application/json';
        if (method !== 'GET' && !headers['x-csrf-token']) { if (!state.csrf) await fetchCsrf(); headers['x-csrf-token'] = state.csrf; }
        const reqInfo = { method, url, reqHeaders: headers, reqBody: opts.body, path };
        const end = group(`api ${method} ${path}`);
        let res;
        try { res = await fetch(url, { method, credentials: 'include', headers, body: opts.body }); }
        catch (e) { end(); throw { ...reqInfo, name: 'NetworkError', code: 'network_error', message: `Network error calling ${method} ${path}`, detail: String(e?.message || e) }; }
        let text = ''; try { text = await res.text(); } catch { }
        let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { }
        log('status:', res.status, res.statusText);
        if (!res.ok) {
            const code = (data && (data.error || data.code)) || undefined;
            const message = (data && (data.message || data.msg)) || undefined;
            end(); throw { ...reqInfo, name: 'HttpError', code: code || 'http_error', error: code, message: message || `HTTP ${res.status} on ${path}`, status: res.status, statusText: res.statusText, data, text, resHeaders: Object.fromEntries(res.headers.entries()), detail: snippet(text || message, 300) };
        }
        end(); return (text ? (data || {}) : {});
    }

    /* ===================== SCROLL LOCK ===================== */
    const scrollLock = { onWheel: null, onTouchMove: null, onKey: null, onTouchStart: null };
    function lockScroll(modal) {
        if (!modal) return;
        document.body.classList.add('dp-noscroll');
        const canScroll = (el) => el && el.scrollHeight > el.clientHeight;

        scrollLock.onWheel = (e) => {
            let t = e.target;
            while (t && t !== modal && t instanceof HTMLElement && !canScroll(t)) t = t.parentElement;
            const scroller = (t && modal.contains(t) && canScroll(t)) ? t : modal;
            const dy = e.deltaY || 0; const top = scroller.scrollTop; const max = scroller.scrollHeight - scroller.clientHeight;
            e.preventDefault(); e.stopPropagation();
            if ((dy < 0 && top <= 0) || (dy > 0 && top >= max) || max <= 0) return;
            scroller.scrollTop = Math.min(max, Math.max(0, top + dy));
        };
        window.addEventListener('wheel', scrollLock.onWheel, { passive: false, capture: true });

        let lastY = 0;
        scrollLock.onTouchStart = (e) => { const t = e.touches && e.touches[0]; if (t) lastY = t.clientY; };
        window.addEventListener('touchstart', scrollLock.onTouchStart, { passive: true, capture: true });

        scrollLock.onTouchMove = (e) => {
            let t = modal.contains(e.target) ? e.target : modal;
            while (t && t !== modal && t instanceof HTMLElement && !(t.scrollHeight > t.clientHeight)) t = t.parentElement;
            const scroller = (t && modal.contains(t)) ? t : modal;
            const touch = e.touches ? e.touches[0] : null; if (!touch) return;
            const dy = lastY ? lastY - touch.clientY : 0; lastY = touch.clientY;
            const top = scroller.scrollTop; const max = scroller.scrollHeight - scroller.clientHeight;
            e.preventDefault(); e.stopPropagation();
            if ((dy < 0 && top <= 0) || (dy > 0 && top >= max) || max <= 0) return;
            scroller.scrollTop = Math.min(max, Math.max(0, top + dy));
        };
        window.addEventListener('touchmove', scrollLock.onTouchMove, { passive: false, capture: true });

        scrollLock.onKey = (e) => {
            const keys = [' ', 'Spacebar', 'Space', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'];
            if (!keys.includes(e.key)) return;
            const scroller = modal; const page = scroller.clientHeight * 0.9; let delta = 0;
            if (e.key === 'ArrowDown') delta = 60;
            if (e.key === 'ArrowUp') delta = -60;
            if (e.key === 'PageDown' || e.key === ' ' || e.key === 'Spacebar' || e.key === 'Space') delta = page;
            if (e.key === 'PageUp') delta = -page;
            e.preventDefault(); e.stopPropagation();
            if (e.key === 'Home') scroller.scrollTop = 0;
            else if (e.key === 'End') scroller.scrollTop = scroller.scrollHeight;
            else scroller.scrollTop = Math.min(scroller.scrollHeight, Math.max(0, scroller.scrollTop + delta));
        };
        window.addEventListener('keydown', scrollLock.onKey, { capture: true });

        log('scroll lock engaged');
    }
    function unlockScroll() {
        document.body.classList.remove('dp-noscroll');
        if (scrollLock.onWheel) window.removeEventListener('wheel', scrollLock.onWheel, { capture: true });
        if (scrollLock.onTouchMove) window.removeEventListener('touchmove', scrollLock.onTouchMove, { capture: true });
        if (scrollLock.onTouchStart) window.removeEventListener('touchstart', scrollLock.onTouchStart, { capture: true });
        if (scrollLock.onKey) window.removeEventListener('keydown', scrollLock.onKey, { capture: true });
        scrollLock.onWheel = scrollLock.onTouchMove = scrollLock.onTouchStart = scrollLock.onKey = null;
        log('scroll lock released');
    }

    /* ===================== THEME (overwrite-proof) ===================== */
    function upsertAuthOverlayTheme() {
        let s = document.getElementById('dp-auth-overlay-theme');
        if (!s) {
            s = document.createElement('style');
            s.id = 'dp-auth-overlay-theme';
            s.textContent = `
/* ===== Auth Overlay — overwrite-proof ===== */
#dp-overlay, #dp-overlay * {
  box-sizing: border-box !important;
  font-family:'Voice1','Montserrat',system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif !important;
  color:#fff !important;
}

/* Body scroll lock */
body.dp-noscroll { overflow: hidden !important; }

/* Backdrop + container */
#dp-overlay{
  position:fixed !important; inset:0 !important;
  display:none !important; align-items:center !important; justify-content:center !important;
  background:rgba(0,0,0,.72) !important; z-index:10080 !important;
  overscroll-behavior: contain !important;
}
#dp-overlay.dp-open{ display:flex !important; }

/* Layering / modal surface */
#dp-overlay .dp-backdrop{ position:absolute; inset:0; background:rgba(0,0,0,.6); z-index:0; }
#dp-overlay .dp-modal{
  position:relative; z-index:1; display:flex !important; flex-direction:column !important; gap:12px !important;
  width:min(520px,92vw) !important; max-height:min(90vh,760px) !important;
  overflow:auto !important; -webkit-overflow-scrolling: touch !important; overscroll-behavior: contain !important;
  background:#000 !important; color:#fff !important; color-scheme: dark !important;
  border:2px solid #fff !important; border-radius:0 !important; box-shadow:0 10px 40px rgba(0,0,0,.5) !important;
  padding:16px 16px 18px !important;
}

/* Title / muted */
#dp-overlay h2{ margin:0 0 8px 0 !important; font-size:22px !important; font-weight:700 !important; }
#dp-overlay .muted{ font-size:.92em !important; opacity:.85 !important; margin-top:6px !important; color:#fff !important; }
#dp-overlay #dp-msg{ color:#fca5a5 !important; min-height:1.2em !important; text-align:center !important; }

/* Tabs */
#dp-tabs{ display:grid !important; grid-template-columns:1fr 1fr !important; gap:10px !important; margin:4px 0 8px 0 !important; }
#dp-tabs button{
  background:#000 !important; color:#fff !important; border:2px solid #fff !important; border-radius:0 !important;
  min-height:36px !important; padding:10px 12px !important; font-weight:600 !important; cursor:pointer !important;
  transition:background-color .12s ease, color .12s ease, border-color .12s ease !important; background-image:none !important;
}
#dp-tabs button:hover{ background:#fff !important; color:#000 !important; border-color:#fff !important; }
#dp-tabs button.active{ background:#fff !important; color:#000 !important; border-color:#fff !important; }

/* Close */
#dp-overlay .dp-close{
  position:absolute !important; right:10px !important; top:8px !important;
  width:32px !important; height:32px !important; line-height:28px !important;
  background:#000 !important; color:#fff !important; border:2px solid #fff !important; border-radius:0 !important;
  cursor:pointer !important; text-align:center !important; font-size:18px !important; padding:0 !important;
}
#dp-overlay .dp-close:hover{ background:#fff !important; color:#000 !important; }

/* Form rhythm */
#dp-content{ display:grid !important; grid-auto-rows:auto !important; row-gap:12px !important; }
#dp-overlay label{ margin:0 !important; font-size:14px !important; opacity:.95 !important; }
#dp-overlay label .req{ color:#fff !important; }
#dp-overlay label + input{ margin-top:6px !important; }
#dp-overlay input + label{ margin-top:12px !important; }

/* Inputs — text-like only (exclude checkbox/radio) */
#dp-overlay .dp-modal input[type="text" i],
#dp-overlay .dp-modal input[type="email" i],
#dp-overlay .dp-modal input[type="tel" i],
#dp-overlay .dp-modal input[type="password" i],
#dp-overlay .dp-modal input:not([type]){
  width:100% !important; min-height:40px !important; padding:10px 12px !important;
  background:#000 !important; background-color:#000 !important; background-image:none !important;
  color:#fff !important; caret-color:#fff !important;
  border:2px solid #fff !important; border-radius:0 !important;
  outline:none !important; box-shadow:none !important;
  -webkit-appearance:none !important; appearance:none !important;
  background-clip: padding-box !important;
}
#dp-overlay .dp-modal input::placeholder{ color:rgba(255,255,255,.75) !important; }
#dp-overlay .dp-modal input:focus-visible{ outline:2px solid #fff !important; outline-offset:2px !important; }

/* Checkbox — custom themed square to match buttons/borders */
#dp-overlay .dp-check{
  display:flex !important; align-items:center !important; gap:10px !important;
  user-select:none !important; cursor:pointer !important;
}
#dp-overlay .dp-check input[type="checkbox"]{
  -webkit-appearance:none !important; appearance:none !important;
  width:18px !important; height:18px !important; margin:0 !important;
  background:#000 !important; border:2px solid #fff !important; border-radius:0 !important;
  display:inline-grid !important; place-content:center !important;
  position:relative !important; transition:background-color .12s ease !important;
}
#dp-overlay .dp-check input[type="checkbox"]::before{
  content:"" !important; width:10px !important; height:10px !important;
  background:#fff !important; transform:scale(0) !important; transition:transform .12s ease-in-out !important;
}
#dp-overlay .dp-check input[type="checkbox"]:checked::before{ transform:scale(1) !important; }
#dp-overlay .dp-check input[type="checkbox"]:hover{ background:#111 !important; }
#dp-overlay .dp-check input[type="checkbox"]:focus-visible{
  outline:2px solid #fff !important; outline-offset:2px !important;
}

/* Error outline */
#dp-overlay .dp-modal .dp-error{
  border-color:#f87171 !important;
  outline:2px solid #f87171 !important; outline-offset:2px !important;
}
#dp-overlay .dp-check input[type="checkbox"].dp-error{
  outline:2px solid #f87171 !important; outline-offset:2px !important; border-color:#f87171 !important;
}

/* Autofill */
#dp-overlay .dp-modal input:-webkit-autofill,
#dp-overlay .dp-modal input:-webkit-autofill:hover,
#dp-overlay .dp-modal input:-webkit-autofill:focus{
  -webkit-box-shadow: 0 0 0 1000px #000 inset !important;
  box-shadow: 0 0 0 1000px #000 inset !important;
  -webkit-text-fill-color:#fff !important; caret-color:#fff !important; border:2px solid #fff !important;
}
#dp-overlay .dp-modal input:-moz-autofill,
#dp-overlay .dp-modal input:-moz-autofill-preview{
  box-shadow: 0 0 0 1000px #000 inset !important;
  -moz-text-fill-color:#fff !important; color:#fff !important;
}

/* Buttons */
#dp-overlay button, #dp-overlay .dp-btn{
  background:#000 !important; color:#fff !important; border:2px solid #fff !important; border-radius:0 !important;
  min-height:36px !important; padding:10px 12px !important; font-weight:600 !important;
  cursor:pointer !important; background-image:none !important;
  transition:background-color .12s ease, color .12s ease, border-color .12s ease !important;
}
#dp-overlay button:hover, #dp-overlay .dp-btn:hover{ background:#fff !important; color:#000 !important; }
#dp-overlay button:active, #dp-overlay .dp-btn:active{ background:#000 !important; color:#fff !important; }
#dp-overlay button:focus-visible{ outline:2px solid #fff !important; outline-offset:2px !important; }
#dp-overlay .dp-btn-full{ width:100% !important; }

/* Actions area (Register + terms) — centered */
#dp-overlay .dp-actions{
  display:flex !important; flex-direction:column !important; align-items:stretch !important;
  gap:8px !important; margin-top:4px !important; text-align:center !important;
}
#dp-overlay .dp-terms{ text-align:center !important; }

/* 2FA row spacing (more room under label) */
#dp-overlay #dp-totp-row{ margin-top:14px !important; }
#dp-overlay #dp-totp-row > label{ display:block !important; margin-bottom:10px !important; }

/* Links */
#dp-overlay a{ color:#fff !important; text-decoration:none !important; user-select:text !important; }
#dp-overlay a:hover{ text-decoration:underline !important; }
`;
            document.head.appendChild(s);
        }
        ensureAuthThemeLast();
    }
    function ensureAuthThemeLast() {
        const s = document.getElementById('dp-auth-overlay-theme');
        if (s && s !== document.head.lastElementChild) { document.head.removeChild(s); document.head.appendChild(s); }
    }

    /* ===================== PASSWORD ASTERISK MASK ===================== */
    function attachAsteriskMask(visibleInput, hiddenInput) {
        const vis = (typeof visibleInput === 'string') ? document.getElementById(visibleInput) : visibleInput;
        const hid = (typeof hiddenInput === 'string') ? document.getElementById(hiddenInput) : hiddenInput;
        if (!vis || !hid) return;
        let real = hid.value || '';
        const maskChar = '*';
        const paint = () => { vis.value = maskChar.repeat(real.length); };
        const setCaret = (pos) => { requestAnimationFrame(() => { try { vis.setSelectionRange(pos, pos); } catch { } }); };
        let selStart = 0, selEnd = 0;
        vis.addEventListener('beforeinput', () => { selStart = vis.selectionStart || 0; selEnd = vis.selectionEnd || selStart; });
        vis.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData('text') || '';
            real = real.slice(0, selStart) + text + real.slice(selEnd);
            hid.value = real; paint(); setCaret(selStart + text.length);
            hid.dispatchEvent(new Event('input'));
        });
        vis.addEventListener('input', (e) => {
            const t = e.inputType || '';
            if (t === 'insertText') {
                const ch = e.data || '';
                real = real.slice(0, selStart) + ch + real.slice(selEnd);
                hid.value = real; paint(); setCaret(selStart + ch.length);
            } else if (t === 'deleteContentBackward') {
                if (selStart === selEnd && selStart > 0) {
                    real = real.slice(0, selStart - 1) + real.slice(selEnd);
                    hid.value = real; paint(); setCaret(selStart - 1);
                } else {
                    real = real.slice(0, selStart) + real.slice(selEnd);
                    hid.value = real; paint(); setCaret(selStart);
                }
            } else if (t === 'deleteContentForward') {
                if (selStart === selEnd) real = real.slice(0, selStart) + real.slice(selStart + 1);
                else real = real.slice(0, selStart) + real.slice(selEnd);
                hid.value = real; paint(); setCaret(selStart);
            } else {
                paint();
            }
            hid.dispatchEvent(new Event('input'));
        });
        vis.autocomplete = vis.autocomplete || 'new-password';
        vis.spellcheck = false;
        paint();
    }

    /* ===================== ERROR UX HELPERS ===================== */
    function clearErrors(scope) { (scope || state.overlay)?.querySelectorAll('.dp-error')?.forEach(el => el.classList.remove('dp-error')); }
    function markError(el) { if (el) el.classList.add('dp-error'); }
    function markErrorById(id) { const el = byId(id); if (el) el.classList.add('dp-error'); }
    function focusFirstError(scope) { const el = (scope || state.overlay)?.querySelector('.dp-error'); if (el && el.focus) el.focus(); }
    function attachErrorClearOnInput(ids) {
        ids.forEach(id => {
            const el = byId(id); if (!el) return;
            const fn = () => el.classList.remove('dp-error');
            el.addEventListener('input', fn);
            el.addEventListener('change', fn);
            el.addEventListener('blur', fn);
        });
    }

    /* ===================== SUBMIT ON ENTER ===================== */
    function bindEnter(container, buttonId) {
        const root = (typeof container === 'string') ? byId(container) : container;
        const btn = byId(buttonId);
        if (!root || !btn) return;
        const handler = (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                const tag = (e.target.tagName || '').toLowerCase();
                if (tag === 'textarea') return;
                e.preventDefault();
                btn.click();
            }
        };
        root.addEventListener('keydown', handler);
    }

    /* ===================== OVERLAY UI ===================== */
    function closeOverlay(reason = 'unknown') {
        if (!state.overlay) return;
        log('close overlay (reason:', reason, ')');
        state.overlay.classList.remove('dp-open');
        unlockScroll();
    }

    function ensureOverlay() {
        if (state.overlay) { log('ensureOverlay: reuse existing'); return state.overlay; }

        log('ensureOverlay: creating overlay DOM');
        const el = document.createElement('div');
        el.id = 'dp-overlay';
        el.style.cssText = 'position:fixed;inset:0;z-index:10080;';
        el.innerHTML = `
      <div class="dp-backdrop"></div>
      <div class="dp-modal">
        <button class="dp-close" title="Close" style="position:absolute;right:10px;top:8px;background:none;border:none;color:#fff;font-size:20px;cursor:pointer">×</button>
        <div id="dp-tabs" style="display:flex;gap:8px;margin-bottom:10px">
          <button data-tab="login" class="active">Login</button>
          <button data-tab="register">Register</button>
        </div>
        <div id="dp-content"></div>
        <div class="muted" id="dp-msg" style="min-height:1.2em;margin-top:8px"></div>
      </div>
    `;
        document.body.appendChild(el);
        state.overlay = el;

        upsertAuthOverlayTheme();

        const modal = el.querySelector('.dp-modal');

        const backdrop = el.querySelector('.dp-backdrop');
        backdrop.addEventListener('click', () => {
            const dt = performance.now() - state.openedAt;
            if (dt < 300) { log('backdrop click ignored (debounce,', Math.round(dt), 'ms)'); return; }
            closeOverlay('backdrop');
        });
        modal.addEventListener('click', (e) => e.stopPropagation());
        el.querySelector('.dp-close').addEventListener('click', () => closeOverlay('close-button'));

        const [btnLogin, btnReg] = el.querySelectorAll('#dp-tabs button');
        btnLogin.addEventListener('click', () => { setActiveTab(btnLogin, btnReg); renderLogin(); });
        btnReg.addEventListener('click', () => { setActiveTab(btnReg, btnLogin); renderRegister(); });

        return el;
    }

    function setActiveTab(activeBtn, otherBtn) {
        activeBtn.classList.add('active');
        otherBtn.classList.remove('active');
        msg('');
        log('tab ->', activeBtn.dataset.tab || activeBtn.textContent);
    }

    function showOverlay(startTab = 'login') {
        log('showOverlay startTab=', startTab);
        ensureOverlay();
        state.openedAt = performance.now();
        state.overlay.classList.add('dp-open');

        const modal = state.overlay.querySelector('.dp-modal');
        lockScroll(modal);

        const [btnLogin, btnReg] = state.overlay.querySelectorAll('#dp-tabs button');
        if (startTab === 'register') { setActiveTab(btnReg, btnLogin); renderRegister(); }
        else { setActiveTab(btnLogin, btnReg); renderLogin(); }

        upsertAuthOverlayTheme();
    }

    /* ===================== VIEWS ===================== */
    function renderLogin() {
        log('renderLogin');
        const c = byId('dp-content');
        if (!c) { warn('renderLogin: #dp-content missing'); return; }
        c.innerHTML = `
      <h2 style="margin:0 0 8px">Welcome back</h2>
      <label><span>Email, phone, or username</span></label>
      <input id="dp-id" autocomplete="username" placeholder="name@example.com, +15555550123, or handle">
      <label>Password</label>
      <input id="dp-pw" type="hidden" value="">
      <input id="dp-pw-vis" type="text" autocomplete="current-password" placeholder="Min 7, < 32, 1 capital, 1 number, 1 symbol">
      <div id="dp-totp-row" style="display:none;margin-top:14px">
        <label>2FA Code</label>
        <div style="display:flex;gap:10px">
          <input id="dp-totp" inputmode="numeric" placeholder="123456" style="flex:1">
          <button id="dp-sendcode" type="button" title="Send code to your email/phone" style="white-space:nowrap">Send code</button>
        </div>
      </div>
      <button id="dp-login" class="dp-btn-full" style="margin-top:10px">Login</button>
      <div class="muted" style="margin-top:6px;text-align:center"><a href="#" id="dp-reset">Forgot password?</a></div>
    `;
        attachAsteriskMask('dp-pw-vis', 'dp-pw');

        attachErrorClearOnInput(['dp-id', 'dp-pw-vis', 'dp-totp']);
        bindEnter(c, 'dp-login');

        const idInput = byId('dp-id');
        idInput.addEventListener('blur', () => {
            const raw = idInput.value.trim();
            if (!raw) return;
            if (raw.includes('@')) idInput.value = sanitizeEmail(raw);
            else if (/^\+?[\d\s().-]+$/.test(raw)) idInput.value = sanitizePhone(raw);
            else idInput.value = raw.trim();
        });

        const show2fa = (hint) => {
            const row = byId('dp-totp-row'); if (row) row.style.display = '';
            msg(hint || 'Enter your 2FA Code.');
        };

        byId('dp-sendcode').onclick = async () => {
            try { await fetchCsrf(); msg('Check Dev Mailbox for the code.'); }
            catch { msg('Could not send code.'); }
        };

        byId('dp-login').onclick = async () => {
            msg(''); clearErrors(c);
            const rawId = idInput.value.trim();
            const password = byId('dp-pw').value;
            const totp = (byId('dp-totp')?.value || '').trim();

            let hasErr = false;
            if (!rawId) { markError(idInput); hasErr = true; }
            if (!password) { markError(byId('dp-pw-vis')); hasErr = true; }
            if (hasErr) { msg('Please fill the highlighted fields.'); focusFirstError(c); return; }

            let identifier = '';
            if (rawId.includes('@')) {
                const e = sanitizeEmail(rawId);
                if (!isEmail(e)) { markError(idInput); msg('Invalid email.'); return; }
                identifier = e;
            } else if (/^\+?[\d\s().-]+$/.test(rawId)) {
                const p = sanitizePhone(rawId);
                if (!isPhone(p)) { markError(idInput); msg('Invalid phone number.'); return; }
                identifier = p;
            } else {
                const u = validateUsername(rawId);
                if (!u.ok) { markError(idInput); msg('Invalid username.'); return; }
                identifier = u.username;
            }

            try {
                await fetchCsrf();
                const body = { identifier, password };
                if (totp) body.totp = totp;
                await api('/auth/login', { method: 'POST', body: JSON.stringify(body) });
                msg('Logged in.');
                closeOverlay('login-success');
                Promise.resolve((window.DP && DP.syncAfterLogin) ? DP.syncAfterLogin() : null).catch(err => warn('post-login sync failed:', err));
            } catch (e) {
                if (e?.error === 'totp_required') { show2fa('Enter your authenticator app code.'); return; }
                if (e?.error === 'totp_invalid') { show2fa('That authenticator code was invalid.'); markError(byId('dp-totp')); return; }
                if (e?.error === 'email_otp_required') { show2fa('We sent a 6-digit code to your email. Enter it above.'); return; }
                if (e?.error === 'email_otp_invalid') { show2fa('That 6-digit code was invalid. Try again.'); markError(byId('dp-totp')); return; }
                if (e?.error === 'email_otp_expired') { show2fa('That code expired. Click “Send code” and try again.'); markError(byId('dp-totp')); return; }
                if (e?.error) msg(`Login failed: ${e.error}`); else msg('Login failed');
            }
        };

        byId('dp-reset').onclick = async (ev) => {
            ev.preventDefault();
            try {
                await fetchCsrf();
                await api('/auth/password/reset/request', { method: 'POST', body: JSON.stringify({ identifier: idInput.value.trim() }) });
                msg('Reset link sent to Dev Mailbox.');
            } catch { msg('Reset failed.'); }
        };

        upsertAuthOverlayTheme();
    }

    function renderRegister() {
        log('renderRegister');
        const c = byId('dp-content');
        if (!c) { warn('renderRegister: #dp-content missing'); return; }
        c.innerHTML = `
      <h2 style="margin:0 0 8px">Create account</h2>

      <label>Username <span class="req" aria-hidden="true">*</span> <span class="muted" style="font-weight:normal;">(3–24 letters, numbers, _)</span></label>
      <input id="dp-username" placeholder="your_handle" autocomplete="off">

      <label>Email <span class="req" aria-hidden="true">*</span></label>
      <input id="dp-email" autocomplete="email" placeholder="name@example.com">

      <label>Confirm email <span class="req" aria-hidden="true">*</span></label>
      <input id="dp-email2" autocomplete="email" placeholder="Re-enter your email">

      <label>Phone (optional)</label>
      <input id="dp-phone" placeholder="+15555550123" autocomplete="tel">

      <label>Password <span class="req" aria-hidden="true">*</span></label>
      <input id="dp-pw" type="hidden" value="">
      <input id="dp-pw-vis" type="text" autocomplete="new-password" placeholder="Min 7, < 32, 1 capital, 1 number, 1 symbol">

      <label>Confirm password <span class="req" aria-hidden="true">*</span></label>
      <input id="dp-pw2" type="hidden" value="">
      <input id="dp-pw2-vis" type="text" autocomplete="new-password" placeholder="Re-enter your password">

      <label class="dp-check" style="margin-top:10px">
        <input id="dp-optin" type="checkbox">
        <span>I agree to be sent emails when new pleas are posted, and other information.</span>
      </label>

      <div class="dp-actions" style="margin-top:10px">
        <button id="dp-reg" class="dp-btn-full">Register</button>
        <div class="muted dp-terms" style="user-select:text">
          By registering, you agree to the following
          <a href="/terms-and-conditions/9-30-2025" target="_blank" rel="noopener noreferrer">terms and conditions</a>.
        </div>
      </div>
    `;
        attachAsteriskMask('dp-pw-vis', 'dp-pw');
        attachAsteriskMask('dp-pw2-vis', 'dp-pw2');

        attachErrorClearOnInput(['dp-username', 'dp-email', 'dp-email2', 'dp-phone', 'dp-pw-vis', 'dp-pw2-vis', 'dp-optin']);
        bindEnter(c, 'dp-reg');

        const inputEmail = byId('dp-email');
        const inputEmail2 = byId('dp-email2');
        const inputPhone = byId('dp-phone');

        inputEmail.addEventListener('blur', () => { inputEmail.value = sanitizeEmail(inputEmail.value); });
        inputEmail2.addEventListener('blur', () => { inputEmail2.value = sanitizeEmail(inputEmail2.value); });
        inputPhone.addEventListener('blur', () => { inputPhone.value = sanitizePhone(inputPhone.value); });

        const pw = byId('dp-pw');
        pw?.addEventListener('input', () => {
            const v = validatePassword(pw.value);
            if (!v.ok) msg('Password needs: ' + v.reasons.join(', ') + '.'); else msg('');
        });

        byId('dp-reg').onclick = async () => {
            msg(''); clearErrors(c);

            const usernameRaw = byId('dp-username').value.trim();
            const emailRaw = inputEmail.value;
            const email2Raw = inputEmail2.value;
            const phoneRaw = inputPhone.value;
            const email = sanitizeEmail(emailRaw);
            const email2 = sanitizeEmail(email2Raw);
            const phone = sanitizePhone(phoneRaw);
            const password = pw.value;
            const password2 = byId('dp-pw2').value;
            const optin = byId('dp-optin').checked;

            let missing = false;
            if (!usernameRaw) { markErrorById('dp-username'); missing = true; }
            if (!email) { markErrorById('dp-email'); missing = true; }
            if (!email2) { markErrorById('dp-email2'); missing = true; }
            if (!password) { markErrorById('dp-pw-vis'); missing = true; }
            if (!password2) { markErrorById('dp-pw2-vis'); missing = true; }
            if (!optin) { markErrorById('dp-optin'); missing = true; }
            if (missing) { msg('Please fill the highlighted fields.'); focusFirstError(c); return; }

            const u = validateUsername(usernameRaw);
            if (!u.ok) { markErrorById('dp-username'); msg(u.reason); return; }

            if (!isEmail(email)) { markErrorById('dp-email'); msg('Invalid email.'); return; }
            if (!isEmail(email2)) { markErrorById('dp-email2'); msg('Invalid confirmation email.'); return; }
            if (email !== email2) { markErrorById('dp-email'); markErrorById('dp-email2'); msg('Emails do not match.'); return; }

            if (phone && !isPhone(phone)) { markErrorById('dp-phone'); msg('Invalid phone number.'); return; }

            const p = validatePassword(password);
            if (!p.ok) { markErrorById('dp-pw-vis'); msg('Password needs: ' + p.reasons.join(', ') + '.'); return; }
            if (password !== password2) { markErrorById('dp-pw-vis'); markErrorById('dp-pw2-vis'); msg('Passwords do not match.'); return; }

            try {
                await fetchCsrf().catch((e) => { throw { ...e, action: 'Fetch CSRF' }; });
                await api('/auth/register', {
                    method: 'POST',
                    body: JSON.stringify({ username: u.username, email, phone: phone || null, password, consent_emails: true })
                }).catch((e) => { throw { ...e, action: 'Register' }; });

                try {
                    const localSave = JSON.parse(localStorage.getItem('dp_save') || 'null');
                    if (localSave) {
                        await api('/saves/sync', { method: 'POST', body: JSON.stringify({ localSave }) })
                            .catch((e) => { throw { ...e, action: 'Carry-over saves (sync)' }; });
                    }
                } catch (e) {
                    showSpecificError('Carry-over saves (sync)', { method: 'POST', path: '/saves/sync', detail: String(e?.message || e) });
                }

                msg('Account created. You are signed in.');
                closeOverlay('register-success');
                if (window.DP && DP.syncAfterLogin) {
                    Promise.resolve(DP.syncAfterLogin()).catch((err) => {
                        showSpecificError('Post-register sync', { method: 'POST', path: '(custom sync)', detail: String(err?.message || err) });
                    });
                }
            } catch (e) {
                if (e?.error === 'invalid_username') { markErrorById('dp-username'); msg('Username must be 3–24 characters: letters, numbers, underscore.'); return; }
                if (e?.error === 'username_banned') { markErrorById('dp-username'); msg('That username is not allowed. Pick a different one.'); return; }
                if (e?.error === 'username_taken') { markErrorById('dp-username'); msg('That username is taken. Try another.'); return; }
                if (e?.error === 'user_exists') { markErrorById('dp-email'); msg('Email or phone already in use.'); return; }
                if (e?.error === 'weak_password') { markErrorById('dp-pw-vis'); msg('Password too weak. Use a stronger one.'); return; }
                showSpecificError(e.action || 'Register', e);
            }
        };

        upsertAuthOverlayTheme();
    }

    /* ===================== EXPORTS & AUTOBIND ===================== */
    window.DP = window.DP || {};
    window.DP.init = (opts = {}) => { if (opts.apiBase) state.apiBase = opts.apiBase; log('DP.init', opts); };
    window.DP.openAuth = (startTab = 'login') => { log('DP.openAuth called with', startTab); showOverlay(startTab); };
    window.DP.syncAfterLogin = window.DP.syncAfterLogin || (async () => { log('syncAfterLogin (default noop)'); });

    window.addEventListener('DOMContentLoaded', () => {
        log('DOMContentLoaded: binding triggers');
        const btn = document.getElementById('dp-login-btn');
        if (btn) { log('#dp-login-btn found — binding click'); btn.addEventListener('click', () => showOverlay('login')); }
        else { warn('#dp-login-btn not found at DOMContentLoaded'); }
        document.addEventListener('click', (e) => {
            const t = e.target;
            if (t && t.id === 'dp-login-btn') { log('delegated click on #dp-login-btn'); showOverlay('login'); }
        }, { capture: true });
    });

    window.addEventListener('load', () => { log('window.load: DP available =', !!window.DP); });
})();
