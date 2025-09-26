// plea page (reader) — DEBUG BUILD
document.addEventListener('DOMContentLoaded', () => {
    console.log('PLEA BUILD', new Date().toISOString());

    /***********************
     * DEBUG SETTINGS
     ***********************/
    const DEBUG = true;
    const API_BASE = 'http://localhost:3000/api';  // change if needed
    const STATIC_ORIGINS = ['http://localhost:5500', 'http://127.0.0.1:5500'];

    /* ==========================================================
       VOTE SHIM — sends a single best-guess request
       - Intercepts POST/PUT/PATCH /api/comments/:id/vote
       - Converts bodies to {vote:'up'|'down'|'none'} once
       - Preserves credentials + CSRF header; never loops on itself
       Keep near the top of main.js (after API_BASE)
    ========================================================== */
    (function installVoteShim() {
        if (window.__DP_VOTE_SHIM_SIMPLE__) return;
        window.__DP_VOTE_SHIM_SIMPLE__ = true;

        const nativeFetch = window.fetch.bind(window);
        const CSRF_HEADER = 'X-CSRF-Token';

        function getCookie(name) {
            const m = (document.cookie || '').match(new RegExp('(?:^|; )' + name.replace(/[$()*+./?[\\\]^{|}-]/g, '\\$&') + '=([^;]*)'));
            return m ? decodeURIComponent(m[1]) : '';
        }
        function getCsrf() {
            return document.querySelector('meta[name="csrf"]')?.content || getCookie('csrf') || '';
        }
        function toURL(u) { try { return new URL(u, location.origin); } catch { return null; } }
        function looksLikeVote(u) {
            const url = toURL(u);
            if (!url) return false;
            const base = API_BASE.replace(/\/$/, '');
            if (!(url.origin + url.pathname).startsWith(base)) return false;
            return /\/comments\/\d+\/vote$/.test(url.pathname);
        }
        function readDir(init, urlObj) {
            let dir = urlObj?.searchParams?.get('direction');
            if (dir !== 'up' && dir !== 'down' && dir !== 'none') dir = null;
            try {
                if (!dir && init?.body) {
                    if (typeof init.body === 'string') {
                        try {
                            const j = JSON.parse(init.body);
                            if (j.vote === 'up' || j.vote === 'down' || j.vote === 'none') dir = j.vote;
                            else if (j.direction === 'up' || j.direction === 'down' || j.direction === 'none') dir = j.direction;
                            else if (typeof j.delta === 'number') dir = j.delta > 0 ? 'up' : (j.delta < 0 ? 'down' : 'none');
                            else if (typeof j.value === 'number') dir = j.value > 0 ? 'up' : (j.value < 0 ? 'down' : 'none');
                            else if (j.type === 'like') dir = 'up';
                            else if (j.type === 'dislike') dir = 'down';
                            else if (j.type === 'clear' || j.type === 'unvote') dir = 'none';
                        } catch { /* ignore */ }
                    }
                }
            } catch { }
            return dir || 'up';
        }

        window.fetch = async function (input, init = {}) {
            // bypass our own calls
            if (init && init.__dpVoteShim) return nativeFetch(input, init);

            const urlStr = typeof input === 'string' ? input : (input && input.url) || '';
            if (!looksLikeVote(urlStr)) return nativeFetch(input, init);

            const url = toURL(urlStr);
            const dir = readDir(init, url);
            const headers = new Headers(init?.headers || {});
            if (!headers.has('Accept')) headers.set('Accept', 'application/json');
            if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
            const csrf = getCsrf();
            if (csrf && !headers.has(CSRF_HEADER)) headers.set(CSRF_HEADER, csrf);

            // Single best-guess request
            const body = JSON.stringify({ vote: dir });
            return nativeFetch(urlStr, {
                method: init?.method || 'POST',
                credentials: 'include',
                headers,
                body,
                __dpVoteShim: true
            });
        };

        console.info?.('[vote-shim] simple installed');
    })();

    // style-y debug printers
    function dgroup(title) { if (!DEBUG) return () => { }; console.groupCollapsed('%c' + title, 'color:#3b82f6;font-weight:600'); return () => console.groupEnd(); }
    function dlog(...a) { if (DEBUG) console.log(...a); }
    function dwarn(...a) { if (DEBUG) console.warn(...a); }
    function derr(...a) { if (DEBUG) console.error(...a); }

    async function diagFetch(url, opts = {}) {
        const t0 = performance.now();
        const label = `[fetch] ${opts.method || 'GET'} ${url}`;
        const endG = dgroup(label);
        try {
            dlog('options:', opts);
            const res = await fetch(url, opts);
            const text = await res.text();
            const dt = Math.round(performance.now() - t0);
            dlog('status:', res.status, res.statusText, `(${dt}ms)`);
            dlog('headers:', [...res.headers.entries()]);
            dlog('body(text):', text.slice(0, 400) + (text.length > 400 ? '…' : ''));
            endG();
            try { return JSON.parse(text); } catch { return text; }
        } catch (err) {
            derr('NETWORK ERROR ->', err?.name, err?.message);
            if (location.protocol === 'file:') {
                derr('You are on file:// — use a local server like http://localhost:5500).');
            }
            derr('If this is a CORS issue, make sure your API allows your static origin via CORS.');
            endG();
            throw err;
        }
    }

    /***********************
     * BASIC HELPERS
     ***********************/
    function currentPleaNumber() {
        const m = location.pathname.match(/\/(\d{1,6})\/?$/);
        if (m) return parseInt(m[1], 10);
        const t = document.querySelector('.plea-number')?.textContent || '';
        const n = t.match(/Plea\s*#\s*(\d+)/i);
        return n ? parseInt(n[1], 10) : null;
    }

    let firstRevealStarted = false;
    let uiUnlocked = false;
    let current = 0;
    let revealing = false;
    let timeouts = [];
    let promptTimer = null;
    let replayBtnMounted = false;

    const PLEA_NUM = currentPleaNumber();
    const KEY = PLEA_NUM ? `plea-progress:${PLEA_NUM}` : null;
    const RETURN_KEY = 'plea:return';

    function killRevealTimers() {
        try { timeouts.forEach(clearTimeout); } catch { }
        timeouts = [];
        try { clearTimeout(promptTimer); } catch { }
    }
    function readProgress() {
        if (!KEY) return null;
        try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
        catch { return null; }
    }
    function writeProgress(obj) {
        if (!KEY) return;
        try { localStorage.setItem(KEY, JSON.stringify({ ...obj, updatedAt: new Date().toISOString() })); }
        catch { }
    }
    function clearLastIndexKeepDone() {
        const p = readProgress() || {};
        writeProgress({ done: !!p.done, lastIndex: undefined });
    }
    function clearProgressCompletely() {
        if (KEY) { try { localStorage.removeItem(KEY); } catch { } }
    }
    function stashReturnTarget() { if (PLEA_NUM) sessionStorage.setItem(RETURN_KEY, String(PLEA_NUM)); }

    // UI refs
    const sections = document.querySelectorAll('.container .section');
    const animateSections = Array.from(sections).slice(1);
    const prompt = document.getElementById('continue-prompt');
    const container = document.querySelector('.container');
    const startOverlay = document.getElementById('start-overlay');
    const startText = document.getElementById('start-text');
    const ellipsis = document.getElementById('ellipsis');
    container?.scrollTo?.({ top: 0, behavior: 'auto' });

    // Audio
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const volumeNode = audioCtx.createGain(); volumeNode.gain.setValueAtTime(0.5, audioCtx.currentTime); volumeNode.connect(audioCtx.destination);
    let clickBuffer = null, resumed = false, started = false, lastClickTime = 0;

    const cfg = (() => {
        const dataHum = document.body?.dataset?.hum;
        const dataThr = document.body?.dataset?.clickThrottle;
        const metaHum = document.querySelector('meta[name="dp:hum"]')?.content;
        const metaThr = document.querySelector('meta[name="dp:click_throttle"]')?.content;
        let hum = dataHum || metaHum || 'Voice0Hum.wav';
        if (!/^https?:\/\//i.test(hum) && !hum.startsWith('/')) hum = '/sounds/' + hum;
        let throttle = parseInt(dataThr || metaThr || '50', 10);
        if (!Number.isFinite(throttle)) throttle = 50;
        return { HUM_SRC: hum, CLICK_THROTTLE: throttle };
    })();

    // Debug banner
    (function printBootInfo() {
        const end = dgroup('BOOT');
        dlog('href:', location.href);
        dlog('origin:', location.origin);
        dlog('protocol:', location.protocol);
        dlog('API_BASE:', API_BASE);
        dlog('STATIC_ORIGINS allowed:', STATIC_ORIGINS);
        dlog('PLEA_NUM:', PLEA_NUM);
        dlog('KEY:', KEY);
        dlog('#sections:', sections.length, 'animateSections:', animateSections.length);
        dlog('progress:', readProgress());
        end();
    })();

    // Load click sound
    fetch(cfg.HUM_SRC)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} for audio`); return r.arrayBuffer(); })
        .then(data => audioCtx.decodeAudioData(data))
        .then(buf => { clickBuffer = buf; dlog('[audio] loaded'); })
        .catch(err => derr('Audio load failed:', err));

    requestAnimationFrame(() => startText?.classList.add('visible'));

    function playClick() {
        if (!clickBuffer || !resumed) return;
        const now = performance.now();
        if (now - lastClickTime < cfg.CLICK_THROTTLE) return;
        lastClickTime = now;
        const src = audioCtx.createBufferSource();
        src.buffer = clickBuffer; src.connect(volumeNode); src.start();
    }

    // wrap every char
    animateSections.forEach(section => {
        const raw = section.textContent;
        section.textContent = '';
        Array.from(raw).forEach(ch => {
            if (ch === ' ') section.appendChild(document.createTextNode(' '));
            else { const span = document.createElement('span'); span.textContent = ch; span.className = 'char'; section.appendChild(span); }
        });
    });

    // hub button
    (function addPleaHubButton() {
        const HUB_URL = '/pleas/';
        const ICON_SRC = '/icons/plea-hub.png';
        const a = document.createElement('a');
        a.href = HUB_URL; a.className = 'plea-hub-btn'; a.setAttribute('aria-label', 'Open Plea Select');
        const img = new Image(); img.src = ICON_SRC; img.alt = 'Plea Select'; img.decoding = 'async'; img.loading = 'eager'; img.draggable = false;
        a.appendChild(img); document.body.appendChild(a);
        a.addEventListener('click', () => { stashReturnTarget(); }, { capture: true });
        requestAnimationFrame(() => a.classList.add('is-show'));
    })();

    // prompt helpers
    const hidePrompt = () => { clearTimeout(promptTimer); if (prompt) prompt.classList.remove('visible'); };
    const schedulePrompt = idx => { clearTimeout(promptTimer); const delay = idx === 0 ? 2500 : 6000; promptTimer = setTimeout(() => prompt.classList.add('visible'), delay); };

    // progress
    const progress0 = readProgress();
    const PROGRESS_LOCKED_DONE = !!progress0?.done;
    const RESUME_INDEX = (!PROGRESS_LOCKED_DONE && Number.isFinite(progress0?.lastIndex))
        ? Math.max(0, Math.min(animateSections.length, progress0.lastIndex | 0))
        : 0;

    // --- comments loader
    const COMMENT_PATHS = [
        `${location.origin}/web/comments.js`,
        `/web/comments.js`,
        `${location.origin}/comments.js`,
        `/comments.js`,
    ];

    function loadCommentsLib() {
        if (window.DP && typeof window.DP.mountComments === 'function') {
            console.log('[comments] already on window.DP');
            return Promise.resolve('already_loaded');
        }
        document.querySelectorAll('script[data-dp-comments]').forEach(n => n.remove());
        return new Promise((resolve, reject) => {
            let i = 0;
            const bust = 'v=' + Date.now();
            function tryNext() {
                if (i >= COMMENT_PATHS.length) {
                    console.error('[comments] Could not load from any path:', COMMENT_PATHS);
                    return reject(new Error('comments_js_load_failed'));
                }
                const url = COMMENT_PATHS[i++];
                const s = document.createElement('script');
                s.async = true;
                s.dataset.dpComments = '1';
                s.src = url + (url.includes('?') ? '&' : '?') + bust;
                s.onload = () => { console.info('[comments] loaded:', s.src); resolve(url); };
                s.onerror = () => { console.warn('[comments] failed:', s.src); s.remove(); tryNext(); };
                document.head.appendChild(s);
            }
            tryNext();
        });
    }

    // Styling helpers
    function openAnyAccordions(root) {
        root.querySelectorAll('details').forEach(d => d.open = true);
        const toggles = root.querySelectorAll('.dp-c-toggle, [aria-controls*="comments"], [data-action*="toggle"], .accordion-toggle, summary');
        toggles.forEach(btn => {
            try {
                const expanded = btn.getAttribute('aria-expanded');
                if (expanded === 'false' || expanded == null) btn.click?.();
            } catch { }
        });
    }
    function ensureCenteredPagers(root) {
        const pagers = root.querySelectorAll('.dp-pager, .dp-fb-pager');
        pagers.forEach(p => {
            p.style.display = 'grid';
            p.style.placeItems = 'center';
            p.style.width = '100%';
            [...p.children].forEach(ch => {
                ch.style.float = 'none';
                ch.style.margin = '0 auto';
                ch.style.display = 'inline-flex';
            });
            const btn = p.querySelector('.dp-next, .dp-loadmore, .dp-fb-next, button, a');
            if (btn && !(/\S/.test(btn.textContent))) btn.textContent = 'View more comments';
        });
    }

    // CSRF + current user
    let __CSRF = null;
    let __ME = null;
    async function ensureCsrf() {
        if (__CSRF) return __CSRF;
        try {
            const j = await diagFetch(`${API_BASE.replace('/api', '')}/api/csrf`, { credentials: 'include' });
            __CSRF = (j && (j.csrfToken || j.csrf || j.token)) || null;
        } catch { }
        return __CSRF;
    }
    async function ensureMe() {
        if (__ME) return __ME;
        const tries = [
            `${API_BASE.replace('/api', '')}/api/me`,
            `${API_BASE}/me`,
            `${API_BASE.replace('/api', '')}/me`
        ];
        for (const u of tries) {
            try {
                const j = await diagFetch(u, { credentials: 'include' });
                if (j && (j.id || j.user?.id)) { __ME = j.user || j; break; }
            } catch { }
        }
        return __ME;
    }
    function authHeaders(extra = {}) {
        const h = { 'Accept': 'application/json', 'Content-Type': 'application/json', ...extra };
        if (__CSRF) h['X-CSRF-Token'] = __CSRF;
        return h;
    }

    // User cache to resolve names
    const USER_CACHE = new Map();
    async function fetchUserById(id) {
        if (!id) return null;
        if (USER_CACHE.has(id)) return USER_CACHE.get(id);
        const urls = [
            `${API_BASE}/users/${encodeURIComponent(id)}`,
            `${API_BASE.replace('/api', '')}/api/users/${encodeURIComponent(id)}`
        ];
        for (const u of urls) {
            try {
                const j = await diagFetch(u, { credentials: 'include' });
                if (j && (j.id || j.username || j.name || j.display_name)) {
                    USER_CACHE.set(id, j);
                    return j;
                }
            } catch { }
        }
        USER_CACHE.set(id, null);
        return null;
    }

    // Normalizers
    const nId = c => c?.id ?? c?.comment_id ?? c?._id ?? null;
    const nBody = c => c?.body ?? c?.text ?? c?.content ?? '';
    const nAuthorId = c => c?.author?.id ?? c?.user?.id ?? c?.user_id ?? c?.author_id ?? null;
    const nCreatedAtRaw = c => c?.created_at ?? c?.createdAt ?? c?.timestamp ?? null;
    const nTime = c => { const x = nCreatedAtRaw(c) || Date.now(); try { return new Date(x).toLocaleString(); } catch { return ''; } };
    const nUp = c => Number(c?.likes ?? c?.up ?? c?.upvotes ?? 0) || 0;
    const nDown = c => Number(c?.dislikes ?? c?.down ?? c?.downvotes ?? 0) || 0;
    const nMyVote = c => {
        const v = c?.my_vote ?? c?.user_vote ?? c?.vote_by_me ?? c?.liked_by_me ?? c?.disliked_by_me;
        if (v === 'up' || v === 1 || v === true) return 1;
        if (v === 'down' || v === -1) return -1;
        if (v === 0 || v === null || typeof v === 'undefined') return 0;
        return 0;
    };
    function nAuthorLocal(c) {
        return c?.author?.username ?? c?.author?.display_name ?? c?.user?.username ?? c?.user?.name ?? c?.username ?? c?.name ?? '';
    }
    async function resolveDisplayName(c, fallbackIndex = 0) {
        let name = nAuthorLocal(c);
        if (name && String(name).trim()) return String(name).trim();
        const uid = nAuthorId(c);
        if (uid != null) {
            const u = await fetchUserById(uid);
            const n = u?.username || u?.display_name || u?.name;
            if (n && String(n).trim()) return String(n).trim();
            return `User#${uid}`;
        }
        return `User#${fallbackIndex || 0}`;
    }

    // Permissions
    function isOwner(c, me) {
        if (c?.me_is_author === true || c?.owned_by_me === true) return true;
        const authorId = nAuthorId(c);
        return me?.id != null && authorId != null && String(authorId) === String(me.id);
    }
    function canDelete(c, me) {
        if (c?.can_delete === true) return true;
        if (me?.is_admin || me?.admin) return true;
        return isOwner(c, me);
    }
    function canEdit(c, me) {
        if (c?.can_edit === true) return true;
        if (!isOwner(c, me)) return false;
        const created = nCreatedAtRaw(c);
        if (!created) return false;
        const ageMs = Date.now() - new Date(created).getTime();
        return ageMs <= 24 * 60 * 60 * 1000; // <= 1 day
    }

    // API wrappers (minimal & single-shot)
    async function apiList(pleaNum, page = 1, page_size = 10, sort = 'hottest') {
        const url = `${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments?sort=${encodeURIComponent(sort)}&page=${page}&page_size=${page_size}`;
        const r = await diagFetch(url, { credentials: 'include' });
        const items = Array.isArray(r?.items) ? r.items : (Array.isArray(r) ? r : []);
        const total = Number.isFinite(r?.total) ? +r.total : items.length;
        return { items, total, page, page_size };
    }
    async function apiReplies(pleaNum, parentId) {
        const url = `${API_BASE}/comments/${encodeURIComponent(parentId)}/replies`;
        try {
            const r = await diagFetch(url, { credentials: 'include' });
            const arr = Array.isArray(r?.items) ? r.items : (Array.isArray(r) ? r : []);
            return arr;
        } catch {
            return [];
        }
    }
    async function apiPostComment(pleaNum, body) {
        await ensureCsrf();
        const url = `${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments`;
        const r = await fetch(url, { method: 'POST', credentials: 'include', headers: authHeaders(), body: JSON.stringify({ body }), __dpVoteShim: true });
        if (!r.ok) throw new Error('post_comment_failed');
        return r.json().catch(() => ({}));
    }
    async function apiPostReply(pleaNum, parentId, body) {
        await ensureCsrf();
        const url = `${API_BASE}/comments/${encodeURIComponent(parentId)}/replies`;
        const r = await fetch(url, { method: 'POST', credentials: 'include', headers: authHeaders(), body: JSON.stringify({ body }), __dpVoteShim: true });
        if (!r.ok) throw new Error('post_reply_failed');
        return r.json().catch(() => ({}));
    }
    async function apiDeleteComment(pleaNum, id) {
        await ensureCsrf();
        const url = `${API_BASE}/comments/${encodeURIComponent(id)}`;
        const r = await fetch(url, { method: 'DELETE', credentials: 'include', headers: authHeaders(), __dpVoteShim: true });
        if (!(r.ok || r.status === 204)) throw new Error('delete_failed');
        return true;
    }
    async function apiEditComment(pleaNum, id, bodyText) {
        await ensureCsrf();
        const url = `${API_BASE}/comments/${encodeURIComponent(id)}`;
        const r = await fetch(url, { method: 'PATCH', credentials: 'include', headers: authHeaders(), body: JSON.stringify({ body: bodyText }), __dpVoteShim: true });
        if (!r.ok) throw new Error('edit_failed');
        return r.json().catch(() => ({}));
    }
    async function apiGetMyVote(pleaNum, id) {
        // single GET-ish probe variants
        const tries = [
            `${API_BASE}/comments/${encodeURIComponent(id)}/vote`,
            `${API_BASE}/comments/${encodeURIComponent(id)}/my_vote`
        ];
        for (const u of tries) {
            try {
                const j = await diagFetch(u, { credentials: 'include' });
                if (j && (j.vote === 'up' || j.direction === 'up' || j.delta === 1 || j.value === 1 || j.liked === true)) return 1;
                if (j && (j.vote === 'down' || j.direction === 'down' || j.delta === -1 || j.value === -1 || j.disliked === true)) return -1;
                if (typeof j?.my_vote === 'number') return j.my_vote > 0 ? 1 : j.my_vote < 0 ? -1 : 0;
            } catch { }
        }
        return 0;
    }
    async function apiSetMyVote(pleaNum, id, newVote) {
        await ensureCsrf();
        const url = `${API_BASE}/comments/${encodeURIComponent(id)}/vote`;
        const dir = newVote > 0 ? 'up' : (newVote < 0 ? 'down' : 'none');
        const r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: authHeaders(),
            body: JSON.stringify({ vote: dir }),
            __dpVoteShim: true
        });
        if (!(r.ok || r.status === 204)) throw new Error('vote_failed');
        return true;
    }

    // DOM helpers
    function $e(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function makeComposer(ph = 'Write a comment…', onSubmit) {
        const wrap = $e('div', 'dp-fb-composer');
        const ta = document.createElement('textarea');
        ta.placeholder = ph;
        ta.rows = 3;
        ta.style.width = '100%';
        ta.style.resize = 'vertical';
        const row = $e('div', 'dp-fb-composer-row');
        const btn = $e('button', 'dp-fb-post', 'Post');
        btn.type = 'button';
        btn.addEventListener('click', async () => {
            const val = ta.value.trim();
            if (!val) return;
            btn.disabled = true;
            try { await onSubmit(val); ta.value = ''; } finally { btn.disabled = false; }
        });
        row.appendChild(btn);
        wrap.appendChild(ta);
        wrap.appendChild(row);
        return { wrap, textarea: ta, button: btn };
    }

    // THEME: Voice1/Montserrat + white + active vote highlighting
    function injectThemeCSS() {
        if (document.getElementById('dp-comments-theme')) return;
        const s = document.createElement('style');
        s.id = 'dp-comments-theme';
        s.textContent = `
#dp-comments-wrap{display:block;width:100%;clear:both;margin-top:28px;grid-column:1/-1;}
#dp-comments-host{display:block;width:100%;--dp-max-width:640px}
#dp-comments-host, #dp-comments-host *{
  font-family:'Voice1','Montserrat',system-ui,-apple-system,Segoe UI,Roboto,sans-serif !important;
  color:#fff !important;
}
#dp-comments-host .dp-shell{max-width:var(--dp-max-width);margin:0 auto;padding:12px;border:1px solid rgba(255,255,255,.12);border-radius:12px;background:transparent}
#dp-comments-host .dp-title{text-align:center;font-size:22px;margin:0 0 10px}
#dp-comments-host .dp-fb-list{max-width:var(--dp-max-width);margin:0 auto;display:grid;gap:18px}
#dp-comments-host .dp-item{border-top:1px solid rgba(255,255,255,.12);padding-top:12px}
#dp-comments-host .dp-head{font-size:13px;opacity:.9;text-align:center;margin-bottom:10px}
#dp-comments-host .dp-body{font-size:17px;white-space:pre-wrap;line-height:1.45}
#dp-comments-host .dp-actions{display:flex;justify-content:center;gap:10px;margin-top:12px;font-size:14px;flex-wrap:wrap}
#dp-comments-host .dp-btn, #dp-comments-host .dp-next, #dp-comments-host .dp-fb-post{
  cursor:pointer;background:transparent;border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:6px 10px; transition:all .15s ease;
}
#dp-comments-host .dp-btn:hover{border-color:rgba(255,255,255,.5)}
#dp-comments-host .dp-btn.is-like{border-color:#93c5fd}
#dp-comments-host .dp-btn.is-dislike{border-color:#fca5a5}
#dp-comments-host .dp-btn.is-active{background:#1f2937;box-shadow:0 0 0 1px rgba(147,197,253,.25) inset}
#dp-comments-host .dp-btn.is-active.is-dislike{box-shadow:0 0 0 1px rgba(252,165,165,.25) inset}
#dp-comments-host .dp-btn[disabled], #dp-comments-host .dp-next[disabled]{opacity:.6;cursor:not-allowed}
#dp-comments-host .dp-replies{margin-top:10px;border-left:2px solid rgba(255,255,255,.15);padding-left:12px}
#dp-comments-host .dp-reply{margin-top:12px;opacity:.95}
#dp-comments-host .dp-fb-pager{display:flex;justify-content:center;align-items:center;margin-top:14px}
#dp-comments-host .dp-next{margin:0 auto;display:inline-flex}
#dp-comments-host textarea{font:inherit;background:#0b0f19;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px;color:#fff}
#dp-comments-host .dp-fb-composer-row{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
#dp-comments-host .dp-fb-composer-row .dp-btn{border-style:dashed}

/* vendor (light DOM) max-width + fonts */
#dp-comments-host .dp-comments,
#dp-comments-host .dp-c-panel,
#dp-comments-host .dp-list,
#dp-comments-host .dp-item,
#dp-comments-host .dp-c-composer{max-width:var(--dp-max-width);margin:0 auto;}
#dp-comments-host .dp-c-panel{background:transparent!important;border:1px solid rgba(255,255,255,.12)!important;padding:12px;}
#dp-comments-host .dp-c-title{font-size:22px;}
#dp-comments-host .dp-meta{font-size:13px;text-align:center;margin-bottom:10px;}
#dp-comments-host .dp-body{font-size:17px;margin-top:0;}
#dp-comments-host .dp-actions .dp-btn{font-size:inherit;}

/* pager centering */
#dp-comments-host .dp-pager, #dp-comments-host .dp-fb-pager{
  display:flex !important; justify-content:center !important; align-items:center !important; width:100% !important; text-align:center !important; margin-top:12px !important;
}
#dp-comments-host .dp-pager > *, #dp-comments-host .dp-fb-pager > *{ float:none !important; margin:0 auto !important; display:inline-flex !important; }
#dp-comments-host .dp-pager .dp-prev{ display:none !important; }

/* body scroll like before */
.container{overflow:visible!important;height:auto!important;max-height:none!important;}
html,body{height:auto;overflow-y:auto;}
`;
        document.head.appendChild(s);
    }

    function computedLooksWrong(host) {
        const sample = host.querySelector('.dp-body, .dp-item, .dp-shell, [class*="dp-"]') || host;
        const cs = sample && getComputedStyle(sample);
        if (!cs) return false;
        const color = (cs.color || '').replace(/\s+/g, '').toLowerCase();
        const ff = (cs.fontFamily || '').toLowerCase();
        const isBlack = color === 'rgb(0,0,0)' || color === '#000' || color === 'black';
        const wrongFont = !(ff.includes('voice1') || ff.includes('montserrat'));
        return isBlack || wrongFont;
    }

    async function mountCommentsForPlea(pleaNum) {
        console.groupCollapsed('%cCOMMENTS: mount', 'color:#3b82f6;font-weight:600');
        try {
            injectThemeCSS();

            await loadCommentsLib().catch(() => { });
            if (window.DP?.init) window.DP.init({ apiBase: API_BASE });

            // Host below the plea content
            const containerEl = document.querySelector('.container') || document.body;
            document.querySelectorAll('#dp-comments-host, #dp-comments-wrap').forEach(n => n.remove());
            const wrap = document.createElement('div');
            wrap.id = 'dp-comments-wrap';
            wrap.className = containerEl.className || 'container';
            containerEl.insertAdjacentElement('afterend', wrap);
            const host = document.createElement('div');
            host.id = 'dp-comments-host';
            wrap.appendChild(host);

            // Try vendor first; fall back if fonts/colors are wrong or no items
            async function tryVendor() {
                if (!window.DP?.mountComments) return false;
                const maybe = window.DP.mountComments(pleaNum, host);
                try { await Promise.resolve(maybe); } catch { }
                setTimeout(() => { openAnyAccordions(host); ensureCenteredPagers(host); }, 50);
                setTimeout(() => { openAnyAccordions(host); ensureCenteredPagers(host); }, 250);
                const bad = computedLooksWrong(host);
                const hasItems = host.querySelector('.dp-item, [data-comment-id]');
                return !bad && !!hasItems;
            }

            // Vote controller — single source of truth for local counts
            function makeVoteController({ id, likeBtn, dislikeBtn, initialUps, initialDowns, initialMy }) {
                const st = { ups: initialUps | 0, downs: initialDowns | 0, my: initialMy | 0, busy: false };

                function render() {
                    if (likeBtn) {
                        likeBtn.textContent = `▲ ${st.ups}`;
                        likeBtn.classList.toggle('is-like', true);
                        likeBtn.classList.toggle('is-active', st.my === 1);
                        likeBtn.classList.toggle('is-dislike', false);
                    }
                    if (dislikeBtn) {
                        dislikeBtn.textContent = `▼ ${st.downs}`;
                        dislikeBtn.classList.toggle('is-dislike', true);
                        dislikeBtn.classList.toggle('is-active', st.my === -1);
                        dislikeBtn.classList.toggle('is-like', false);
                    }
                }

                // Apply local rule:
                // - If I already voted, remove that vote from its count.
                // - Then add 1 to the newly selected side (unless clearing).
                function applyLocal(nextMy) {
                    if (nextMy === st.my) return; // no-op
                    if (st.my === 1) st.ups = Math.max(0, st.ups - 1);
                    if (st.my === -1) st.downs = Math.max(0, st.downs - 1);
                    if (nextMy === 1) st.ups += 1;
                    if (nextMy === -1) st.downs += 1;
                    st.my = nextMy;
                }

                async function commit(nextMy) {
                    if (st.busy) return;
                    st.busy = true;
                    const snap = { ...st };
                    applyLocal(nextMy);
                    render();
                    try {
                        await apiSetMyVote(PLEA_NUM, id, nextMy);
                    } catch {
                        st.ups = snap.ups; st.downs = snap.downs; st.my = snap.my;
                        render();
                    } finally {
                        st.busy = false;
                    }
                }

                likeBtn?.addEventListener('click', () => {
                    if (st.busy) return;
                    const next = st.my === 1 ? 0 : 1;
                    likeBtn.disabled = true; if (dislikeBtn) dislikeBtn.disabled = true;
                    commit(next).finally(() => { likeBtn.disabled = false; if (dislikeBtn) dislikeBtn.disabled = false; });
                });
                dislikeBtn?.addEventListener('click', () => {
                    if (st.busy) return;
                    const next = st.my === -1 ? 0 : -1;
                    dislikeBtn.disabled = true; if (likeBtn) likeBtn.disabled = true;
                    commit(next).finally(() => { dislikeBtn.disabled = false; if (likeBtn) likeBtn.disabled = false; });
                });

                return { state: st, render, setMy: (v) => { applyLocal(v); render(); } };
            }

            // Fallback UI
            async function renderFallback() {
                await ensureCsrf().catch(() => { });
                const me = await ensureMe().catch(() => null);

                const shell = $e('div', 'dp-shell');
                shell.appendChild($e('h3', 'dp-title', 'Comments'));

                // top-level composer
                const topComp = makeComposer('Write a comment…', async (text) => {
                    await apiPostComment(pleaNum, text);
                    page = 1; loaded = 0; list.innerHTML = ''; await addPage(true);
                });
                shell.appendChild(topComp.wrap);

                const list = $e('div', 'dp-fb-list');
                const pager = $e('div', 'dp-fb-pager');
                const nextBtn = $e('button', 'dp-next', 'View more comments');
                pager.appendChild(nextBtn);

                host.innerHTML = '';
                host.appendChild(shell);
                host.appendChild(list);
                host.appendChild(pager);

                let page = 1, page_size = 10, total = 0, loaded = 0, lastBatchLen = 0, anonCounter = 1;

                function buildManageRow(c, itemBodyEl) {
                    const row = $e('div', 'dp-actions');
                    const allowEdit = canEdit(c, me);
                    const allowDelete = canDelete(c, me);

                    if (allowEdit) {
                        const editBtn = $e('button', 'dp-btn', 'Edit');
                        row.appendChild(editBtn);
                        editBtn.addEventListener('click', () => {
                            const currentText = itemBodyEl.textContent || '';
                            const editor = document.createElement('textarea');
                            editor.value = currentText;
                            editor.rows = Math.min(10, Math.max(3, Math.ceil(currentText.length / 60)));
                            editor.style.width = '100%';
                            editor.style.marginTop = '8px';

                            const saveRow = $e('div', 'dp-fb-composer-row');
                            const cancelBtn = $e('button', 'dp-btn', 'Cancel');
                            const saveBtn = $e('button', 'dp-fb-post', 'Save');
                            saveRow.appendChild(cancelBtn);
                            saveRow.appendChild(saveBtn);

                            const editorWrap = document.createElement('div');
                            editorWrap.appendChild(editor);
                            editorWrap.appendChild(saveRow);
                            itemBodyEl.insertAdjacentElement('afterend', editorWrap);

                            const cleanup = () => editorWrap.remove();
                            cancelBtn.addEventListener('click', cleanup);
                            saveBtn.addEventListener('click', async () => {
                                const newText = editor.value.trim();
                                if (!newText || newText === currentText) { cleanup(); return; }
                                saveBtn.disabled = true;
                                try {
                                    await apiEditComment(PLEA_NUM, nId(c), newText);
                                    itemBodyEl.textContent = newText;
                                    cleanup();
                                } catch {
                                    saveBtn.disabled = false;
                                }
                            });
                        });
                    }

                    if (allowDelete) {
                        const delBtn = $e('button', 'dp-btn', 'Delete');
                        row.appendChild(delBtn);
                        delBtn.addEventListener('click', async () => {
                            if (!confirm('Delete this comment?')) return;
                            delBtn.disabled = true;
                            try {
                                await apiDeleteComment(PLEA_NUM, nId(c));
                                const art = itemBodyEl.closest('article, .dp-reply');
                                if (art) art.remove();
                            } catch {
                                delBtn.disabled = false;
                                alert('Delete failed.');
                            }
                        });
                    }

                    return row;
                }

                async function loadReplies(c, mount, forceReload) {
                    if (mount.__loaded && !forceReload) return;
                    mount.textContent = 'Loading replies…';
                    try {
                        const reps = await apiReplies(pleaNum, nId(c));
                        mount.innerHTML = '';
                        if (!reps.length) {
                            mount.appendChild($e('div', 'dp-reply', '(No replies)'));
                        } else {
                            for (const r of reps) {
                                const it = $e('div', 'dp-reply');
                                const head = $e('div', 'dp-head', '…');
                                it.appendChild(head);

                                const bodyEl = $e('div', 'dp-body', nBody(r));
                                it.appendChild(bodyEl);

                                const likeBtn = $e('button', 'dp-btn', `▲ ${nUp(r)}`);
                                const dislikeBtn = $e('button', 'dp-btn', `▼ ${nDown(r)}`);
                                const actions = $e('div', 'dp-actions');
                                actions.appendChild(likeBtn);
                                actions.appendChild(dislikeBtn);
                                it.appendChild(actions);

                                const vc = makeVoteController({
                                    id: nId(r),
                                    likeBtn, dislikeBtn,
                                    initialUps: nUp(r),
                                    initialDowns: nDown(r),
                                    initialMy: nMyVote(r)
                                });
                                vc.render();

                                if (nMyVote(r) === 0) {
                                    apiGetMyVote(PLEA_NUM, nId(r)).then(v => {
                                        if (v !== vc.state.my) { vc.state.my = v; vc.render(); }
                                    }).catch(() => { });
                                }

                                actions.appendChild(buildManageRow(r, bodyEl));

                                mount.appendChild(it);

                                // Resolve name
                                resolveDisplayName(r, anonCounter++).then(name => {
                                    head.textContent = `${name} • ${nTime(r)}`;
                                }).catch(() => {
                                    head.textContent = `User#${nAuthorId(r) ?? 0} • ${nTime(r)}`;
                                });
                            }
                        }
                        mount.__loaded = true;
                    } catch {
                        mount.innerHTML = '';
                        mount.appendChild($e('div', 'dp-reply', '(Failed to load replies)'));
                    }
                }

                async function addPage() {
                    const { items, total: t } = await apiList(pleaNum, page, page_size, 'hottest');
                    total = t;
                    lastBatchLen = items.length;

                    for (const c of items) {
                        const it = $e('article', 'dp-item');

                        const head = $e('div', 'dp-head', '…');
                        it.appendChild(head);

                        const bodyEl = $e('div', 'dp-body', nBody(c));
                        it.appendChild(bodyEl);

                        const likeBtn = $e('button', 'dp-btn', `▲ ${nUp(c)}`);
                        const dislikeBtn = $e('button', 'dp-btn', `▼ ${nDown(c)}`);
                        const row = $e('div', 'dp-actions');
                        row.appendChild(likeBtn);
                        row.appendChild(dislikeBtn);

                        const vc = makeVoteController({
                            id: nId(c),
                            likeBtn, dislikeBtn,
                            initialUps: nUp(c),
                            initialDowns: nDown(c),
                            initialMy: nMyVote(c)
                        });
                        vc.render();

                        // Ensure current user's existing vote is highlighted once fetched
                        if (nMyVote(c) === 0) {
                            apiGetMyVote(PLEA_NUM, nId(c)).then(v => {
                                if (v !== vc.state.my) { vc.state.my = v; vc.render(); }
                            }).catch(() => { });
                        }

                        // Reply toggle
                        const rc = c?.reply_count ?? c?.replies_count ?? c?.children_count ?? 0;
                        const repliesWrap = $e('div', 'dp-replies');
                        repliesWrap.style.display = 'none';
                        const repliesMount = $e('div', 'dp-replies-list');
                        repliesWrap.appendChild(repliesMount);

                        if (rc > 0) {
                            const toggle = $e('button', 'dp-btn', `View replies (${rc})`);
                            const toggleRow = $e('div', 'dp-actions');
                            toggleRow.appendChild(toggle);
                            toggle.addEventListener('click', async () => {
                                const vis = repliesWrap.style.display !== 'none';
                                repliesWrap.style.display = vis ? 'none' : '';
                                toggle.textContent = vis ? `View replies (${rc})` : 'Hide replies';
                                if (!vis && repliesMount.childElementCount === 0) {
                                    await loadReplies(c, repliesMount, false);
                                }
                            });
                            it.appendChild(toggleRow);
                        }

                        it.appendChild(row);
                        it.appendChild(repliesWrap);

                        // Manage (edit/delete)
                        it.appendChild(buildManageRow(c, bodyEl));

                        // Resolve name (async)
                        resolveDisplayName(c, anonCounter++).then(name => {
                            head.textContent = `${name} • ${nTime(c)}`;
                        }).catch(() => {
                            const uid = nAuthorId(c);
                            head.textContent = `${uid != null ? 'User#' + uid : 'User#0'} • ${nTime(c)}`;
                        });

                        list.appendChild(it);
                        loaded++;
                    }

                    const hasMore = loaded < total && lastBatchLen === page_size;
                    pager.style.display = hasMore ? 'flex' : 'none';
                    nextBtn.style.margin = '0 auto';
                    nextBtn.style.display = 'inline-flex';
                }

                nextBtn.addEventListener('click', async () => {
                    nextBtn.disabled = true;
                    try { page += 1; await addPage(); } finally { nextBtn.disabled = false; }
                });

                await addPage();
            }

            const okVendor = await tryVendor();
            if (!okVendor) await renderFallback();

            // Defensive layout fixes
            openAnyAccordions(host);
            ensureCenteredPagers(host);
            setTimeout(() => { openAnyAccordions(host); ensureCenteredPagers(host); }, 200);
            setTimeout(() => { openAnyAccordions(host); ensureCenteredPagers(host); }, 1000);

            window.DP_DEBUG = { host };
            console.log('[comments] ready.');
        } catch (e) {
            console.error('Comments mount failed:', e);
        } finally {
            console.groupEnd();
        }
    }

    // Keep pager centered even if vendor re-injects DOM
    (function dpCommentsHardPatch() {
        const hostId = 'dp-comments-host';
        if (!document.getElementById('dp-center-pager-and-theme-fix')) {
            const s = document.createElement('style');
            s.id = 'dp-center-pager-and-theme-fix';
            s.textContent = `
#${hostId} .dp-pager, #${hostId} .dp-fb-pager{
  display:grid !important; place-items:center !important; width:100% !important;
  text-align:center !important; margin-top:12px !important;
}
#${hostId} .dp-pager > *, #${hostId} .dp-fb-pager > *{
  float:none !important; margin:0 auto !important; display:inline-flex !important;
}
#${hostId} .dp-next, #${hostId} .dp-loadmore, #${hostId} .dp-fb-next{
  margin:0 auto !important; display:inline-flex !important; font-size:inherit !important;
}
`;
            document.head.appendChild(s);
        }

        function boot() {
            const host = document.getElementById(hostId);
            if (!host) { setTimeout(boot, 100); return; }
            ensureCenteredPagers(host);

            const mo = new MutationObserver(() => { ensureCenteredPagers(host); });
            mo.observe(host, { childList: true, subtree: true });

            setTimeout(() => ensureCenteredPagers(host), 200);
            setTimeout(() => ensureCenteredPagers(host), 1000);
        }
        boot();
    })();


    // Connectivity diagnostics — prints EXACT failures
    async function diagnoseConnectivity(pleaNum) {
        const end = dgroup('DIAGNOSTICS');
        try {
            if (location.protocol === 'file:') {
                derr('Serving from file:// will break fetch and CORS. Use a static server (e.g., http://localhost:5500).');
            }

            dlog('static origin:', location.origin, 'expected among:', STATIC_ORIGINS);
            if (!STATIC_ORIGINS.includes(location.origin)) {
                dwarn('Your static origin is not in STATIC_ORIGINS. If API CORS blocks, add it to server CORS_ORIGIN.');
            }

            await diagFetch(`${API_BASE.replace('/api', '')}/api`, { credentials: 'include' });      // API index
            await diagFetch(`${API_BASE.replace('/api', '')}/api/csrf`, { credentials: 'include' }); // CSRF
            await diagFetch(`${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments?sort=hottest&page=1&page_size=1`, { credentials: 'include' }); // comments
        } finally { end(); }
    }

    /***********************
     * REVEAL ENGINE
     ***********************/
    function beginFirstRevealIfNeeded() {
        if (firstRevealStarted || current >= animateSections.length) return false;
        firstRevealStarted = true;
        dlog('[reveal] starting at index', current);
        revealSection(current);
        current++;
        return true;
    }

    function markProgressAfterSection(idx) {
        if (!KEY || PROGRESS_LOCKED_DONE) return;
        const FINAL_IDX = animateSections.length - 2;
        if (idx >= FINAL_IDX) {
            dlog('[progress] marking done');
            writeProgress({ done: true });
            return;
        }
        const next = Math.max(0, Math.min(animateSections.length, idx + 1));
        dlog('[progress] saving lastIndex', next);
        writeProgress({ done: false, lastIndex: next });
    }

    function preRevealUpTo(idx) {
        dlog('[reveal] prerender up to', idx);
        for (let i = 0; i < idx; i++) {
            const chars = animateSections[i]?.querySelectorAll('.char') || [];
            chars.forEach(c => c.classList.add('visible'));
        }
        const prev = animateSections[idx - 1];
        if (prev) {
            const gutter = container.clientHeight * 0.2;
            const target = Math.max(0, prev.offsetTop - gutter);
            container.scrollTo({ top: target, behavior: 'auto' });
        }
        revealing = false;
        if (idx > 0) schedulePrompt(idx - 1);
    }

    const revealSection = idx => {
        const end = dgroup(`[reveal] section ${idx}`);
        revealing = true;
        const chars = animateSections[idx].querySelectorAll('.char');
        const BASE_SPEED = 30, PERIOD_PAUSE = 300, COMMA_PAUSE = 150;
        let accDelay = 0;

        timeouts.forEach(clearTimeout);
        timeouts = [];

        chars.forEach(c => {
            const id = setTimeout(() => {
                const ch = c.textContent;
                if (ch.trim() !== '') playClick();
                c.classList.add('visible');

                const gutter = container.clientHeight * 0.2;
                const charBottom = c.offsetTop + c.clientHeight;
                const visibleBottom = container.scrollTop + container.clientHeight - gutter;
                if (charBottom > visibleBottom) {
                    const target = charBottom - (container.clientHeight - gutter);
                    container.scrollTo({ top: target, behavior: 'smooth' });
                }

                if (c === chars[chars.length - 1]) onSectionComplete(idx);
            }, accDelay);

            timeouts.push(id);
            accDelay += BASE_SPEED;
            if (c.textContent === '.' || c.textContent === '!' || c.textContent === '?' || c.textContent === ':' || c.textContent === ';') accDelay += PERIOD_PAUSE;
            if (c.textContent === ',' || c.textContent === '"') accDelay += COMMA_PAUSE;
        });
        end();
    };

    function onSectionComplete(idx) {
        revealing = false;
        markProgressAfterSection(idx);
        const FINAL_IDX = animateSections.length - 2;

        if (idx < FINAL_IDX) {
            schedulePrompt(idx);
        } else if (idx === FINAL_IDX) {
            try { gtag('event', 'all_text_revealed', { event_category: 'engagement', event_label: 'full_text' }); } catch { }
            (async () => {
                try {
                    if (PLEA_NUM) await mountCommentsForPlea(PLEA_NUM);
                } finally {
                    mountReplayButton();
                }
            })();

            fetch('https://text-reveal-worker.dupeaccmax.workers.dev/', { method: 'POST', mode: 'cors' })
                .then(r => r.json())
                .then(data => dlog('Beacon transmitted', data.count, 'times'))
                .catch(console.error);
        }
    }

    async function doStartFlow() {
        dlog('[start] connect sequence');
        startText.textContent = 'Connecting'; ellipsis.textContent = '';
        for (let i = 0; i < 3; i++) { await new Promise(r => setTimeout(r, 300)); ellipsis.textContent += '.'; }
        await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));
        startText.textContent = ''; ellipsis.textContent = '';
        await new Promise(r => setTimeout(r, 1000));
        startOverlay.classList.add('hidden');
        await new Promise(r => setTimeout(r, 1000));

        uiUnlocked = true;

        if (!PROGRESS_LOCKED_DONE && RESUME_INDEX > 0) {
            preRevealUpTo(RESUME_INDEX);
            current = RESUME_INDEX;
        } else {
            beginFirstRevealIfNeeded();
            if (PROGRESS_LOCKED_DONE) clearLastIndexKeepDone();
        }
    }

    function onStart(e) {
        e.preventDefault();
        if (started) return;
        started = true;
        dlog('[start] user input');
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(console.error);
        resumed = true;
        doStartFlow();
    }

    function finishCurrentSection() {
        if (!revealing) return false;
        timeouts.forEach(clearTimeout);
        const idx = current - 1;
        animateSections[idx]?.querySelectorAll('.char')?.forEach(c => c.classList.add('visible'));
        onSectionComplete(idx);
        return true;
    }

    // set/hide all text
    function setAllVisible() {
        animateSections.forEach(section => { section.querySelectorAll('.char').forEach(c => c.classList.add('visible')); });
    }
    function hideAllText() {
        animateSections.forEach(section => { section.querySelectorAll('.char').forEach(c => c.classList.remove('visible')); });
    }
    function removeCommentsMount() {
        const host = document.getElementById('dp-comments-host');
        if (host && host.parentNode) host.parentNode.removeChild(host);
    }

    function mountReplayButton() {
        if (replayBtnMounted) return;
        replayBtnMounted = true;

        const btn = document.createElement('button');
        btn.id = 'dp-replay';
        btn.textContent = 'Replay';
        Object.assign(btn.style, {
            position: 'fixed', right: '16px', bottom: '16px', zIndex: 9998,
            padding: '10px 14px', borderRadius: '10px', border: '0',
            background: '#1f2937', color: '#cbd5e1', cursor: 'pointer',
            boxShadow: '0 6px 20px rgba(0,0,0,.35)',
        });
        btn.addEventListener('mouseenter', () => { btn.style.background = '#374151'; });
        btn.addEventListener('mouseleave', () => { btn.style.background = '#1f2937'; });
        btn.onclick = async () => {
            dlog('[replay] clicked');
            clearProgressCompletely();
            removeCommentsMount();
            hidePrompt(); hideAllText();
            container.scrollTo({ top: 0, behavior: 'auto' });
            firstRevealStarted = false; uiUnlocked = false; revealing = false;
            timeouts.forEach(clearTimeout); timeouts = []; current = 0;

            try {
                startText.textContent = 'Tap to begin'; ellipsis.textContent = '';
                startOverlay.classList.remove('hidden'); startOverlay.focus({ preventScroll: true });
            } catch { }

            replayBtnMounted = false; document.getElementById('dp-replay')?.remove();

            try { if (audioCtx.state === 'running') audioCtx.suspend(); } catch { }

            startOverlay.addEventListener('pointerdown', onStart, { once: true });
            startOverlay.addEventListener('touchstart', onStart, { once: true, passive: false });
            startOverlay.addEventListener('click', onStart, { once: true });

            started = false; resumed = false;
        };
        document.body.appendChild(btn);
    }

    async function completeInstantly() {
        dlog('[skip] instant-complete: forcing fully revealed');
        killRevealTimers();
        hidePrompt();
        try { startOverlay.classList.add('hidden'); } catch { }
        started = true;
        uiUnlocked = true;
        firstRevealStarted = true;
        revealing = false;
        current = animateSections.length;
        setAllVisible();
        const gutter = container.clientHeight * 0.2;
        container.scrollTo({
            top: Math.max(0, container.scrollHeight - container.clientHeight - gutter),
            behavior: 'auto'
        });
        try { if (audioCtx.state === 'running') await audioCtx.suspend(); } catch { }
        try {
            if (PLEA_NUM) await mountCommentsForPlea(PLEA_NUM);
        } finally {
            mountReplayButton();
        }
    }

    // Skip connect if fully read before
    if (readProgress()?.done) {
        setTimeout(() => { completeInstantly(); }, 0);
    }

    /***********************
     * INPUTS
     ***********************/
    startOverlay.addEventListener('pointerdown', onStart, { once: true });
    startOverlay.addEventListener('touchstart', onStart, { once: true, passive: false });
    startOverlay.addEventListener('click', onStart, { once: true });

    container.addEventListener('click', () => {
        if (!started || !uiUnlocked) return;
        hidePrompt();
        if (current >= animateSections.length) return;

        if (!firstRevealStarted) { beginFirstRevealIfNeeded(); return; }
        if (finishCurrentSection()) return;

        revealSection(current); current++;
    });

    // Keyboard
    (() => {
        const hubHref = document.querySelector('.plea-hub-btn')?.href || '/pleas/';
        function keyHandler(e) {
            const tag = (e.target?.tagName || '').toLowerCase();
            if (['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable) return;
            if (e.repeat) return;

            const onceFlag = '__pleaHandled'; if (e[onceFlag]) return; e[onceFlag] = true;
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();

            if (e.key === 'Escape' || e.key === 'Esc') { stashReturnTarget(); window.location.assign(hubHref); return; }
            if (e.key === 'Enter') {
                if (!started) { onStart(e); return; }
                if (!uiUnlocked) return;
                hidePrompt();
                if (current >= animateSections.length) return;

                if (!firstRevealStarted) { beginFirstRevealIfNeeded(); return; }
                if (finishCurrentSection()) return;

                revealSection(current); current++;
            }
        }
        window.addEventListener('keydown', keyHandler, { capture: true });
    })();

    /***********************
     * EXTRA: QUICK API HINTS
     ***********************/
    // app.use(cors({ origin: ['http://localhost:5500','http://127.0.0.1:5500'], credentials: true }));
});
