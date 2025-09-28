// plea page (reader) — DEBUG BUILD
document.addEventListener('DOMContentLoaded', () => {
    console.log('PLEA BUILD', new Date().toISOString());

    /***********************
     * DEBUG SETTINGS
     ***********************/
    const DEBUG = true;
    const API_BASE = 'http://localhost:3000/api';  // change if needed
    const STATIC_ORIGINS = ['http://localhost:5500', 'http://127.0.0.1:5500'];

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

    // --- comments loader with diagnostics
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

    // Helpers for styling/behavior
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

    // CSRF + headers (best effort) + current user
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
        try {
            const j = await diagFetch(`${API_BASE}/auth/me`, { credentials: 'include' });
            if (j && (j.id || j.user?.id)) { __ME = j.user || j; }
        } catch { /* ignore */ }
        return __ME;
    }
    function authHeaders(extra = {}, { includeContentType = true } = {}) {
        const h = { Accept: 'application/json', ...extra };
        if (includeContentType) h['Content-Type'] = 'application/json';
        if (__CSRF) h['X-CSRF-Token'] = __CSRF;
        return h;
    }
    function withUserHeaders(extra = {}, opts) {
        const h = authHeaders(extra, opts);
        if (__ME?.id != null) h['X-User-Id'] = String(__ME.id);
        return h;
    }

    // User cache to resolve names
    // ---------- USERNAME-ONLY PROFILE RESOLUTION (no ID-based fetches) ----------

    // strictly for *display* fallbacks — does NOT get used to navigate anywhere
    // (safe to keep for odd backends that only return names, not usernames)
    function firstUsernameOf(u) {
        if (!u) return null;
        const direct = [
            u.first_username, u.firstUsername, u.first_username_slug,
            u.initial_username, u.signup_username, u.username_at_signup,
            u.slug, u.handle, u.username0, u.first
        ].find(v => v && String(v).trim());
        if (direct) return String(direct).trim();

        const arrays = [u.usernames, u.username_history, u.previous_usernames, u.aliases, u.handles];
        for (const arr of arrays) {
            if (Array.isArray(arr) && arr.length) {
                const sorted = [...arr].sort((a, b) => {
                    const ta = new Date((a && (a.created_at || a.at)) || 0).getTime();
                    const tb = new Date((b && (b.created_at || b.at)) || 0).getTime();
                    return ta - tb;
                });
                const pick = sorted[0];
                const val = typeof pick === 'string'
                    ? pick
                    : (pick.username || pick.name || pick.handle || pick.slug);
                if (val) return String(val).trim();
            }
        }
        return null;
    }

    const isUsername = s => /^[A-Za-z0-9_]{3,24}$/i.test(String(s || '').trim());
    const looksLikeHtml = s => typeof s === 'string' && /<html|<!doctype|<pre>|<\/html>/i.test(s);

    // Try to extract the *current* username from a comment payload (author/user fields only)
    function nAuthorCurrentUsername(c) {
        const a = c?.author, u = c?.user;
        const candidates = [
            a?.username, u?.username, c?.username,
            a?.handle, u?.handle
        ];
        const got = candidates.find(v => v && isUsername(v));
        return got ? String(got).trim() : null;
    }

    // Fetch first_username using only the *current* username
    async function fetchFirstOfUsername(uname) {
        if (!isUsername(uname)) return null;

        console.groupCollapsed('%c[first-of] via username', 'color:#f59e0b;font-weight:600');
        console.log('username =', uname);

        // 1) smallest payload
        const tries = [
            `${API_BASE}/users/by_username/${encodeURIComponent(uname)}`,
            `${API_BASE}/users/resolve?username=${encodeURIComponent(uname)}`
        ];

        for (const url of tries) {
            try {
                const j = await diagFetch(url, { credentials: 'include', headers: authHeaders() });
                console.log('checked:', url, '→', j);

                if (typeof j === 'string') {
                    if (!looksLikeHtml(j) && isUsername(j)) {
                        console.log('hit: string body first_username =', j);
                        console.groupEnd();
                        return j.trim();
                    }
                    // HTML error page — ignore
                    continue;
                }

                const first =
                    j?.first_username ||
                    j?.user?.first_username ||
                    j?.firstUsername ||
                    j?.user?.firstUsername ||
                    null;

                if (first && isUsername(first)) {
                    console.log('hit: object.first_username =', first);
                    console.groupEnd();
                    return String(first).trim();
                }
            } catch (e) {
                console.warn('resolver failed', url, e);
            }
        }
        console.warn('no first_username found for', uname);
        console.groupEnd();
        return null;
    }

    // Full resolver: prefer any already-present first_username on the local author object,
    // otherwise look up by current username over the API.
    async function resolveFirstByUsername(comment) {
        const local = comment?.author || comment?.user || null;

        // 0) local hint (if backend already includes first_username in author)
        const localFirst = firstUsernameOf(local);
        if (localFirst && isUsername(localFirst)) return localFirst.trim();

        // 1) derive current username from the comment payload
        const uname = nAuthorCurrentUsername(comment);
        if (!uname) return null;

        // 2) fetch from server by username (never by id)
        return await fetchFirstOfUsername(uname);
    }

    // Human-friendly display name (tries author.username/display_name, then "User#N" fallback).
    async function resolveDisplayName(c, fallbackIndex = 0) {
        // Prefer presentable local fields
        const a = c?.author, u = c?.user;
        const display =
            a?.display_name || u?.display_name ||
            a?.username || u?.username ||
            c?.username || c?.name || '';

        if (String(display).trim()) return String(display).trim();
        return `User#${fallbackIndex || 0}`;
    }

    // Build link text + (maybe) href; href only when we have first_username
    async function authorLinkData(c, fallbackIndex = 0) {
        const display = await resolveDisplayName(c, fallbackIndex);
        let first = firstUsernameOf(c?.author || c?.user);
        if (!first) {
            // Try to resolve now from current username
            first = await resolveFirstByUsername(c);
        }
        const href = first ? `/user/${encodeURIComponent(first)}` : null;

        // DEBUG
        console.groupCollapsed('%c[author-link] resolve', 'color:#f59e0b;font-weight:600');
        console.log({
            commentId: (c?.id ?? c?.comment_id ?? c?._id ?? null),
            currentUsername: nAuthorCurrentUsername(c),
            localFirst: firstUsernameOf(c?.author || c?.user),
            decidedFirst: first,
            href
        });
        console.groupEnd();

        return { display: String(display).trim(), href };
    }

    function setAuthorLine(headEl, comment, fallbackIndex = 0) {
        headEl.textContent = '';

        // --- shared click handler (for both name + avatar)
        async function goProfile(ev, el) {
            ev.stopPropagation();
            if (el.getAttribute('href')) {           // already have href → go
                ev.preventDefault();
                window.location.assign(el.href);
                return;
            }
            ev.preventDefault();                     // late resolve by username → first_username
            const first = await resolveFirstByUsername(comment);
            if (first && isUsername(first)) {
                const url = new URL(`/user/${encodeURIComponent(first)}`, location.origin).toString();
                window.location.assign(url);
            } else {
                alert('Could not open profile — first username not available.');
            }
        }

        // --- avatar (clickable)
        const avatarLink = document.createElement('a');
        avatarLink.className = 'dp-avatar-link';
        avatarLink.rel = 'noopener noreferrer';
        avatarLink.dataset.username = nAuthorCurrentUsername(comment) || '';
        avatarLink.addEventListener('click', (ev) => goProfile(ev, avatarLink));

        const img = document.createElement('img');
        img.className = 'dp-avatar is-fallback';
        img.alt = '';
        img.width = 28; img.height = 28;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = AVATAR_FALLBACK;
        avatarLink.appendChild(img);
        headEl.appendChild(avatarLink);

        // upgrade avatar src asynchronously
        resolveAvatarForComment(comment).then((url) => {
            if (url) { img.src = url; img.classList.remove('is-fallback'); }
        }).catch(() => { /* keep fallback */ });

        // --- name link + time
        authorLinkData(comment, fallbackIndex).then(({ display, href }) => {
            // name (clickable)
            const nameLink = document.createElement('a');
            nameLink.className = 'dp-author';
            nameLink.textContent = display;
            if (href) {
                nameLink.href = href;
                avatarLink.href = href;                // <— make avatar link to the same profile
            }
            nameLink.rel = 'noopener noreferrer';
            nameLink.dataset.username = nAuthorCurrentUsername(comment) || '';
            nameLink.addEventListener('click', (ev) => goProfile(ev, nameLink));

            // improve a11y title/label once we know display text
            avatarLink.title = `View ${display}'s profile`;
            avatarLink.setAttribute('aria-label', `View ${display}'s profile`);

            const sep = document.createTextNode(' \u2022 ');
            const t = document.createElement('span');
            t.className = 'dp-time';
            t.textContent = nTime(comment);

            headEl.appendChild(nameLink);
            headEl.appendChild(sep);
            headEl.appendChild(t);
        }).catch(() => {
            headEl.textContent = `${nAuthorLocal(comment) || 'User'} • ${nTime(comment)}`;
        });
    }

    // --- AVATAR helpers ---------------------------------------------------------
    const AVATAR_FALLBACK =
        'data:image/svg+xml;utf8,' + encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
       <rect width="100%" height="100%" fill="#e5e7eb"/>
       <circle cx="32" cy="24" r="14" fill="#cbd5e1"/>
       <rect x="10" y="40" width="44" height="16" rx="8" fill="#cbd5e1"/>
     </svg>`
        );

    function inlineAvatarOf(c) {
        return c?.author?.profile_photo
            ?? c?.user?.profile_photo
            ?? c?.profile_photo
            ?? c?.author?.photo
            ?? null;
    }

    const AVATAR_CACHE = new Map();

    async function resolveAvatarByUsername(uname) {
        if (!uname) return null;
        const key = 'u:' + uname.toLowerCase();
        if (AVATAR_CACHE.has(key)) return await AVATAR_CACHE.get(key);

        const p = (async () => {
            try {
                const j = await diagFetch(`${API_BASE}/users/by_username/${encodeURIComponent(uname)}`, {
                    credentials: 'include', headers: authHeaders()
                });
                const url = j?.user?.profile_photo ?? j?.profile_photo ?? null;
                if (url) return url;
            } catch { }
            try {
                const j2 = await diagFetch(`${API_BASE}/users/resolve?username=${encodeURIComponent(uname)}`, {
                    credentials: 'include', headers: authHeaders()
                });
                return j2?.user?.profile_photo ?? null;
            } catch { }
            return null;
        })();

        AVATAR_CACHE.set(key, p);
        const r = await p; AVATAR_CACHE.set(key, r);
        return r;
    }

    async function resolveAvatarByFirst(first) {
        if (!first) return null;
        const key = 'f:' + first.toLowerCase();
        if (AVATAR_CACHE.has(key)) return await AVATAR_CACHE.get(key);

        const p = (async () => {
            try {
                const j = await diagFetch(`${API_BASE}/users/by-first/${encodeURIComponent(first)}`, {
                    credentials: 'include', headers: authHeaders()
                });
                const url = j?.user?.profile_photo ?? null;
                if (url) return url;
            } catch { }
            try {
                const j2 = await diagFetch(`${API_BASE}/users/${encodeURIComponent(first)}`, {
                    credentials: 'include', headers: authHeaders()
                });
                return j2?.user?.profile_photo ?? null;
            } catch { }
            return null;
        })();

        AVATAR_CACHE.set(key, p);
        const r = await p; AVATAR_CACHE.set(key, r);
        return r;
    }

    async function resolveAvatarForComment(c) {
        // 1) Inline on the comment?
        const inline = inlineAvatarOf(c);
        if (inline) return inline;

        // 2) Try current username
        const uname = nAuthorCurrentUsername(c);
        if (uname) {
            const viaU = await resolveAvatarByUsername(uname);
            if (viaU) return viaU;
        }

        // 3) Try first_username (local or resolved)
        const firstLocal = firstUsernameOf(c?.author || c?.user);
        if (firstLocal) {
            const viaF = await resolveAvatarByFirst(firstLocal);
            if (viaF) return viaF;
        }

        const first = await resolveFirstByUsername(c);
        if (first) {
            const viaF2 = await resolveAvatarByFirst(first);
            if (viaF2) return viaF2;
        }

        return null;
    }

    // ---------- Normalizers (handles multiple API shapes) ----------
    const nId = c => c?.id ?? c?.comment_id ?? c?._id ?? null;
    const nBody = c => c?.body ?? c?.text ?? c?.content ?? '';

    // Local string-ish name (best-effort; display only)
    const nAuthorLocal = c =>
        c?.author?.username ??
        c?.author?.display_name ??
        c?.user?.username ??
        c?.user?.name ??
        c?.username ??
        c?.name ??
        '';

    // Author numeric ID if present (used only for perms / equality — not for navigation)
    const nAuthorId = c =>
        c?.author?.id ??
        c?.user?.id ??
        c?.user_id ??
        c?.author_id ??
        null;

    const nCreatedAtRaw = c => c?.created_at ?? c?.createdAt ?? c?.timestamp ?? null;
    const nTime = c => {
        const x = nCreatedAtRaw(c) || Date.now();
        try { return new Date(x).toLocaleString(); } catch { return ''; }
    };

    const nUp = c => Number(c?.likes ?? c?.up ?? c?.upvotes ?? 0) || 0;
    const nDown = c => Number(c?.dislikes ?? c?.down ?? c?.downvotes ?? 0) || 0;

    const nMyVote = c => {
        const v = c?.my_vote ?? c?.user_vote ?? c?.vote_by_me ?? c?.liked_by_me ?? c?.disliked_by_me;
        if (v === 'up' || v === 1 || v === true) return 1;
        if (v === 'down' || v === -1) return -1;
        if (v === 0 || v === null || typeof v === 'undefined') return 0;
        return 0;
    };

    const nRepliesCount = c => {
        const a = c?.reply_count ?? c?.replies_count ?? c?.children_count;
        if (Number.isFinite(a)) return +a;
        if (Array.isArray(c?.replies)) return c.replies.length;
        return 0;
    };

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

    // API wrappers (comments + replies + compose + edit + delete)
    async function apiList(pleaNum, page = 1, page_size = 10, sort = 'hottest') {
        const url = `${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments?sort=${encodeURIComponent(sort)}&page=${page}&page_size=${page_size}`;
        const r = await diagFetch(url, { credentials: 'include', headers: withUserHeaders() });
        const items = Array.isArray(r?.items) ? r.items : (Array.isArray(r) ? r : []);
        const total = Number.isFinite(r?.total) ? +r.total : items.length;
        return { items, total, page, page_size };
    }
    async function apiReplies(pleaNum, parentId) {
        const url = `${API_BASE}/comments/${encodeURIComponent(parentId)}/replies`;
        try {
            const r = await diagFetch(url, { credentials: 'include', headers: withUserHeaders() });
            const arr = Array.isArray(r?.items) ? r.items : (Array.isArray(r) ? r : []);
            return arr;
        } catch { return []; }
    }
    async function apiPostComment(pleaNum, body) {
        await ensureCsrf();
        await ensureMe();
        const url = `${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments`;
        const r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: withUserHeaders(),
            body: JSON.stringify({ body })
        });
        if (!r.ok) throw new Error('post_comment_failed');
        return r.json().catch(() => ({}));
    }
    async function apiPostReply(pleaNum, parentId, body) {
        await ensureCsrf();
        await ensureMe();

        // Primary: modern server shape (POST /pleas/:pleaNum/comments with parent_id)
        {
            const url = `${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments`;
            const r = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: withUserHeaders(),
                body: JSON.stringify({ body, parent_id: parentId })
            });
            if (r.ok) return r.json().catch(() => ({}));
        }

        // Fallback: some servers expose POST /comments/:id/replies
        {
            const url = `${API_BASE}/comments/${encodeURIComponent(parentId)}/replies`;
            const r = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: withUserHeaders(),
                body: JSON.stringify({ body })
            });
            if (r.ok) return r.json().catch(() => ({}));
        }

        throw new Error('post_reply_failed');
    }

    function minimalFormHeaders() {
        // Simple headers => no preflight
        return {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        };
    }
    function formQS(obj) {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(obj)) if (v != null) p.append(k, v);
        return p.toString();
    }

    async function apiEditComment(pleaNum, id, bodyText) {
        await ensureCsrf(); // fills __CSRF
        await ensureMe();

        const idEnc = encodeURIComponent(id);
        const url = `${API_BASE}/comments/${idEnc}`;
        const txt = String(bodyText || '').trim();
        if (!txt) throw new Error('edit_failed: empty body');

        // Preflightless attempt: POST form + _method=PATCH + _csrf in BODY
        const form = { _method: 'PATCH', body: txt };
        if (__CSRF) form._csrf = __CSRF;

        let r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: minimalFormHeaders(),
            body: formQS(form),
        });
        if (r.ok) return r.json().catch(() => ({}));

        // Fallback: real PATCH JSON (may preflight)
        r = await fetch(url, {
            method: 'PATCH',
            credentials: 'include',
            headers: withUserHeaders(), // includes JSON content-type + X-CSRF-Token
            body: JSON.stringify({ body: txt }),
        });
        if (r.ok) return r.json().catch(() => ({}));

        throw new Error(
            'edit_failed: ' +
            r.status +
            ' ' +
            r.statusText +
            ' :: ' +
            (await r.text().catch(() => '')).slice(0, 200)
        );
    }

    async function apiDeleteComment(pleaNum, id) {
        await ensureCsrf();
        await ensureMe();

        const idEnc = encodeURIComponent(id);
        const url = `${API_BASE}/comments/${idEnc}`;

        // Preflightless attempt: POST form + _method=DELETE + _csrf in BODY
        const form = { _method: 'DELETE' };
        if (__CSRF) form._csrf = __CSRF;

        let r = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: minimalFormHeaders(),
            body: formQS(form),
        });
        if (r.ok || r.status === 204) return true;

        // Fallback: real DELETE (may preflight)
        r = await fetch(url, {
            method: 'DELETE',
            credentials: 'include',
            headers: authHeaders({}, { includeContentType: false }), // no Content-Type header
        });
        if (r.ok || r.status === 204) return true;

        throw new Error(
            'delete_failed: ' +
            r.status +
            ' ' +
            r.statusText +
            ' :: ' +
            (await r.text().catch(() => '')).slice(0, 200)
        );
    }

    /***********************
     * VOTING (no shims; direct calls)
     ***********************/
    async function apiGetMyVote(pleaNum, id, fallbacksFromItem = 0) {
        if (fallbacksFromItem === 1) return 1;
        if (fallbacksFromItem === -1) return -1;

        const tries = [
            `${API_BASE}/comments/${encodeURIComponent(id)}/my_vote`,
            `${API_BASE}/comments/${encodeURIComponent(id)}/vote`,
            `${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments/${encodeURIComponent(id)}/vote`
        ];
        for (const u of tries) {
            try {
                const j = await diagFetch(u, { credentials: 'include', headers: withUserHeaders() });
                if (j && (j.vote === 'up' || j.direction === 'up' || j.delta === 1 || j.value === 1 || j.liked === true)) return 1;
                if (j && (j.vote === 'down' || j.direction === 'down' || j.delta === -1 || j.value === -1 || j.disliked === true)) return -1;
                if (typeof j?.my_vote === 'number') return j.my_vote > 0 ? 1 : j.my_vote < 0 ? -1 : 0;
            } catch { }
        }
        return 0;
    }

    async function apiSetMyVote(pleaNum, id, newVote) {
        await ensureCsrf();
        await ensureMe();

        const ts = () => new Date().toISOString();
        const dir = newVote > 0 ? 'up' : (newVote < 0 ? 'down' : 'none');
        const headersJSON = withUserHeaders();

        console.groupCollapsed(`%c[vote:${id}] SEND ${dir} @ ${ts()}`, 'color:#22c55e;font-weight:600');
        console.log('me.id:', __ME?.id, 'X-User-Id header?', headersJSON['X-User-Id']);
        console.log('payload:', { value: newVote });

        // --- Primary: modern endpoint with counts + my_vote in response
        try {
            const u = `${API_BASE}/comments/${encodeURIComponent(id)}/vote`;
            const j = await diagFetch(u, {
                method: 'POST',
                credentials: 'include',
                headers: headersJSON,
                body: JSON.stringify(newVote === 0 ? { vote: 'none' } : { value: newVote })
            });
            console.log('[server primary reply]', j);
            if (j && (typeof j.likes !== 'undefined' || typeof j.dislikes !== 'undefined')) {
                console.groupEnd();
                return { ok: true, likes: +j.likes || 0, dislikes: +j.dislikes || 0, my: (typeof j.my_vote === 'number' ? j.my_vote : newVote), source: 'primary' };
            }
        } catch (e) {
            console.warn('[primary] failed -> trying fallbacks', e);
        }

        // --- Fallbacks: cover old shapes
        const urls = [
            // generic vote endpoint
            [`${API_BASE}/comments/${encodeURIComponent(id)}/vote`, 'POST', { vote: dir }],
            [`${API_BASE}/comments/${encodeURIComponent(id)}/vote`, 'POST', { direction: dir }],
            [`${API_BASE}/comments/${encodeURIComponent(id)}/vote`, 'POST', { value: newVote }],
            // react-style
            [`${API_BASE}/comments/${encodeURIComponent(id)}/react`, 'POST', { type: dir === 'none' ? 'clear' : (dir === 'up' ? 'like' : 'dislike') }],
            // semantic paths
            [`${API_BASE}/comments/${encodeURIComponent(id)}/${dir === 'up' ? 'like' : dir === 'down' ? 'dislike' : 'unvote'}`, 'POST', {}],
        ];

        for (const [u, m, body] of urls) {
            try {
                const j = await diagFetch(u, {
                    method: m, credentials: 'include',
                    headers: headersJSON,
                    body: (m === 'POST' || m === 'PUT' || m === 'PATCH') ? JSON.stringify(body) : undefined
                });
                console.log('[server fallback reply]', u, m, j);
                if (j && (typeof j.likes !== 'undefined' || typeof j.dislikes !== 'undefined')) {
                    console.groupEnd();
                    return { ok: true, likes: +j.likes || 0, dislikes: +j.dislikes || 0, my: (typeof j.my_vote === 'number' ? j.my_vote : newVote), source: 'fallback+counts' };
                }
                if (j !== null) { // empty string for 204 will still hit here
                    console.groupEnd();
                    return { ok: true, likes: null, dislikes: null, my: newVote, source: 'fallback' };
                }
            } catch { }
        }

        // --- CLEAR-specific DELETEs (common on RESTy servers)
        if (newVote === 0) {
            const delUrls = [
                `${API_BASE}/comments/${encodeURIComponent(id)}/vote`,
                `${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments/${encodeURIComponent(id)}/vote`
            ];
            for (const du of delUrls) {
                try {
                    const j = await diagFetch(du, { method: 'DELETE', credentials: 'include', headers: headersJSON });
                    console.log('[server delete clear reply]', du, j);
                    console.groupEnd();
                    // We’ll verify after delete anyway
                    return { ok: true, likes: null, dislikes: null, my: 0, source: 'delete-clear' };
                } catch { }
            }
        }

        console.groupEnd();
        // Final safety: verify my_vote after whatever happened
        const mv = await apiGetMyVote(pleaNum, id, 0);
        return { ok: true, likes: null, dislikes: null, my: mv, source: 'verify-only' };
    }

    function makeVoteController(args) {
        const { id, likeBtn, dislikeBtn, onCountsChanged } = args;
        const upsInit = ('ups0' in args) ? args.ups0 : args.initialUps;
        const downsInit = ('downs0' in args) ? args.downs0 : args.initialDowns;
        const myInit = ('myVote0' in args) ? args.myVote0 : args.initialMy;

        const state = {
            ups: Number(upsInit) || 0,
            downs: Number(downsInit) || 0,
            my: (typeof myInit === 'number') ? myInit : 0, // -1,0,1
            resolved: (myInit === 1 || myInit === -1)
        };

        function render() {
            if (likeBtn) {
                likeBtn.textContent = `▲ ${state.ups}`;
                likeBtn.classList.toggle('is-active', state.my === 1);
                likeBtn.classList.remove('is-down');
            }
            if (dislikeBtn) {
                dislikeBtn.textContent = `▼ ${state.downs}`;
                dislikeBtn.classList.toggle('is-down', state.my === -1);
                dislikeBtn.classList.remove('is-active');
            }
        }

        async function ensureKnownMy() {
            if (state.resolved) return;
            console.groupCollapsed(`%c[vote:${id}] ensureKnownMy`, 'color:#60a5fa;font-weight:600');
            try {
                const v = await apiGetMyVote(PLEA_NUM, id, 0);
                console.log('server -> my_vote =', v, ' (was:', state.my, ')');
                if (v === 1 || v === -1 || v === 0) {
                    state.my = v;
                    state.resolved = true;
                    render();
                }
            } finally {
                console.groupEnd();
            }
        }

        async function setMy(nextMy) {
            likeBtn && (likeBtn.disabled = true);
            dislikeBtn && (dislikeBtn.disabled = true);

            await ensureKnownMy();
            const prev = state.my;
            if (nextMy === prev) nextMy = 0; // toggle off

            console.groupCollapsed(`%c[vote:${id}] CLICK`, 'color:#22c55e;font-weight:600');
            console.log('before:', { ups: state.ups, downs: state.downs, my: prev });
            console.log('request:', { nextMy, me: __ME?.id });

            // Temporarily only flip highlight (do NOT touch counts locally)
            state.my = nextMy;
            render();

            try {
                const r = await apiSetMyVote(PLEA_NUM, id, nextMy);
                console.log('server accepted:', r);

                // If server gave counts, trust them
                if (r.likes != null && r.dislikes != null) {
                    state.ups = r.likes;
                    state.downs = r.dislikes;
                } else {
                    // No counts returned: adjust minimally using prev->r.my delta
                    const afterMy = (typeof r.my === 'number') ? r.my : nextMy;
                    const deltaUp = (afterMy === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
                    const deltaDown = (afterMy === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
                    state.ups = Math.max(0, state.ups + deltaUp);
                    state.downs = Math.max(0, state.downs + deltaDown);
                }

                state.my = (typeof r.my === 'number') ? r.my : nextMy;
                state.resolved = true;
                render();
                onCountsChanged && onCountsChanged(state);

                // —— VERIFY on server after write
                console.log('verifying with GET /my_vote …');
                const verifyMy = await apiGetMyVote(PLEA_NUM, id, 0);
                console.log('verify -> my_vote =', verifyMy);
                if (verifyMy !== state.my) {
                    console.error(`[vote:${id}] VERIFY MISMATCH — correcting local`, { local: state.my, server: verifyMy });
                    state.my = verifyMy;
                    render();
                }
            } catch (e) {
                console.error(`[vote:${id}] ERROR`, e);
                // revert highlight on failure
                state.my = prev;
                render();
                onCountsChanged && onCountsChanged(state);
            } finally {
                console.log('after:', { ups: state.ups, downs: state.downs, my: state.my });
                console.groupEnd();
                likeBtn && (likeBtn.disabled = false);
                dislikeBtn && (dislikeBtn.disabled = false);
            }
        }

        likeBtn && likeBtn.addEventListener('click', () => setMy(1));
        dislikeBtn && dislikeBtn.addEventListener('click', () => setMy(-1));

        render();

        // Resolve my vote immediately after mount (with logging)
        ensureKnownMy();

        return { state, render, setMy };
    }

    /***********************
     * THEME
     ***********************/
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
#dp-comments-host .dp-btn.is-active{background:#1f2937;border-color:#93c5fd;box-shadow:0 0 0 1px rgba(147,197,253,.25) inset}
#dp-comments-host .dp-btn.is-down{background:#1f2937;border-color:#fca5a5;box-shadow:0 0 0 1px rgba(252,165,165,.25) inset}
#dp-comments-host .dp-btn[disabled], #dp-comments-host .dp-next[disabled]{opacity:.6;cursor:not-allowed}
#dp-comments-host .dp-replies{margin-top:10px;border-left:2px solid rgba(255,255,255,.15);padding-left:12px}
#dp-comments-host .dp-reply{margin-top:12px;opacity:.95}
#dp-comments-host .dp-fb-pager{display:flex;justify-content:center;align-items:center;margin-top:14px}
#dp-comments-host .dp-next{margin:0 auto;display:inline-flex}
#dp-comments-host textarea{font:inherit;background:#0b0f19;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px;color:#fff}
#dp-comments-host .dp-fb-composer-row{display:flex;justify-content:flex-end;margin-top:6px}

/* vendor (light DOM) */
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

#dp-comments-host .dp-head { user-select: text !important; }
#dp-comments-host .dp-author {
  text-decoration: none;
  cursor: pointer;
  user-select: text !important;
}
#dp-comments-host .dp-author:hover { text-decoration: underline; }
#dp-comments-host .dp-head{
  display:flex; align-items:center; justify-content:center; gap:8px;
}
#dp-comments-host .dp-avatar{
  width:28px; height:28px; border-radius:50%;
  object-fit:cover; background:#1f2937; flex:0 0 28px;
}
#dp-comments-host .dp-avatar.is-fallback{ filter:grayscale(.15); opacity:.9; }
#dp-comments-host .dp-avatar-link{display:inline-flex;border-radius:50%;text-decoration:none}
#dp-comments-host .dp-avatar-link:focus-visible{outline:2px solid #93c5fd;outline-offset:2px}

/* one-page body scroll as before */
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
        console.groupCollapsed('%cCOMMENTS: mount (themed + fallback)', 'color:#3b82f6;font-weight:600');
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

            // Try vendor first
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

            // Full fallback UI (white text, Voice1/Montserrat) with like/dislike/reply + composer + edit/delete
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
                                } catch (e) {
                                    saveBtn.disabled = false;
                                    alert(String(e?.message || e));
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
                            } catch (e) {
                                delBtn.disabled = false;
                                alert(String(e?.message || e));
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
                                    initialUps: nUp(r),
                                    initialDowns: nDown(r),
                                    initialMy: nMyVote(r),
                                    likeBtn,
                                    dislikeBtn
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
                                setAuthorLine(head, r, anonCounter++);
                            }
                        }
                        mount.__loaded = true;
                    } catch {
                        mount.innerHTML = '';
                        mount.appendChild($e('div', 'dp-reply', '(Failed to load replies)'));
                    }
                }

                function makeActions(c, isReply = false, itemBodyEl) {
                    const row = $e('div', 'dp-actions');
                    const id = nId(c);

                    const like = $e('button', 'dp-btn', `▲ ${nUp(c)}`);
                    const dislike = $e('button', 'dp-btn', `▼ ${nDown(c)}`);
                    row.appendChild(like);
                    row.appendChild(dislike);

                    const vc = makeVoteController({
                        id,
                        initialUps: nUp(c),
                        initialDowns: nDown(c),
                        initialMy: nMyVote(c),
                        likeBtn: like,
                        dislikeBtn: dislike
                    });
                    vc.render();

                    // ensure highlight if server knows my vote
                    if (nMyVote(c) === 0) {
                        apiGetMyVote(PLEA_NUM, id, 0).then(v => {
                            if (v !== 0) { vc.state.my = v; vc.render(); }
                        }).catch(() => { });
                    }

                    if (!isReply) {
                        const replyBtn = $e('button', 'dp-btn', 'Reply');
                        row.appendChild(replyBtn);
                        const replyWrap = $e('div', 'dp-replies');
                        replyWrap.style.display = 'none';

                        const replyComp = makeComposer('Write a reply…', async (text) => {
                            await apiPostReply(pleaNum, id, text);
                            await loadReplies(c, repliesMount, true);
                        });
                        replyComp.wrap.style.marginTop = '8px';
                        const repliesMount = $e('div', 'dp-replies-list');
                        replyWrap.appendChild(replyComp.wrap);
                        replyWrap.appendChild(repliesMount);

                        replyBtn.addEventListener('click', async () => {
                            const vis = replyWrap.style.display !== 'none';
                            replyWrap.style.display = vis ? 'none' : '';
                            if (!vis && repliesMount.childElementCount === 0 && nRepliesCount(c) > 0) {
                                await loadReplies(c, repliesMount, false);
                            }
                        });

                        row.appendChild(replyWrap);
                    }

                    // management (edit/delete)
                    row.appendChild(buildManageRow(c, itemBodyEl));

                    return row;
                }

                async function addPage() {
                    const { items, total: t } = await apiList(pleaNum, page, page_size, 'hottest');
                    console.groupCollapsed('%c[list] server items', 'color:#a78bfa;font-weight:600');
                    try {
                        console.table(items.map(c => ({
                            id: nId(c),
                            likes: nUp(c),
                            dislikes: nDown(c),
                            my_vote: nMyVote(c),
                            user_id: nAuthorId(c)
                        })));
                    } finally { console.groupEnd(); }
                    total = t;
                    lastBatchLen = items.length;

                    for (const c of items) {
                        const it = $e('article', 'dp-item');

                        const head = $e('div', 'dp-head', '…');
                        it.appendChild(head);

                        const bodyEl = $e('div', 'dp-body', nBody(c));
                        it.appendChild(bodyEl);

                        // voting + reply + manage for top-level
                        it.appendChild(makeActions(c, false, bodyEl));

                        const rc = nRepliesCount(c);
                        if (rc > 0) {
                            const toggle = $e('button', 'dp-btn', `View replies (${rc})`);
                            const repliesWrap = $e('div', 'dp-replies');
                            repliesWrap.style.display = 'none';
                            const repliesMount = $e('div', 'dp-replies-list');
                            repliesWrap.appendChild(repliesMount);
                            toggle.addEventListener('click', async () => {
                                const vis = repliesWrap.style.display !== 'none';
                                repliesWrap.style.display = vis ? 'none' : '';
                                toggle.textContent = vis ? `View replies (${rc})` : 'Hide replies';
                                if (!vis && repliesMount.childElementCount === 0) {
                                    await loadReplies(c, repliesMount, false);
                                }
                            });
                            const actionsRow = $e('div', 'dp-actions');
                            actionsRow.appendChild(toggle);
                            it.appendChild(actionsRow);
                            it.appendChild(repliesWrap);
                        }

                        // Resolve name (async)
                        setAuthorLine(head, c, anonCounter++);

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

            // Defensive: keep layout fixes applied
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

            // Ping API index
            await diagFetch(`${API_BASE.replace('/api', '')}/api`, { credentials: 'include' });

            // Grab CSRF (cookie + token)
            await diagFetch(`${API_BASE.replace('/api', '')}/api/csrf`, { credentials: 'include' });

            // Try comments endpoint
            await diagFetch(`${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments?sort=hottest&page=1&page_size=1`, { credentials: 'include' });
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
            // Mount comments + Replay
            (async () => {
                try {
                    if (PLEA_NUM) await mountCommentsForPlea(PLEA_NUM);
                } finally {
                    mountReplayButton();
                }
            })();

            // beacon
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

            // re-arm once handlers
            startOverlay.addEventListener('pointerdown', onStart, { once: true });
            startOverlay.addEventListener('touchstart', onStart, { once: true, passive: false });
            startOverlay.addEventListener('click', onStart, { once: true });

            started = false; resumed = false;
        };
        document.body.appendChild(btn);
    }

    async function completeInstantly() {
        dlog('[skip] instant-complete: forcing fully revealed');

        // stop any queued work
        killRevealTimers();
        hidePrompt();

        // hide overlay & block further “start” attempts
        try { startOverlay.classList.add('hidden'); } catch { }

        // mark state as fully finished so click/enter handlers short-circuit
        started = true;
        uiUnlocked = true;
        firstRevealStarted = true;
        revealing = false;
        current = animateSections.length; // <- CRUCIAL: tells handlers we’re at the end

        // reveal everything
        setAllVisible();

        // put viewport near bottom of content without smooth scroll bounce
        const gutter = container.clientHeight * 0.2;
        container.scrollTo({
            top: Math.max(0, container.scrollHeight - container.clientHeight - gutter),
            behavior: 'auto'
        });

        // no clicks -> no sounds, but also suspend audio engine just in case
        try { if (audioCtx.state === 'running') await audioCtx.suspend(); } catch { }

        // mount comments right away (don’t wait for a “first line revealed” event)
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
    // If you still see "NetworkError", verify on the server:
    // app.use(cors({ origin: ['http://localhost:5500','http://127.0.0.1:5500'], credentials: true }));
});

/* ---------- small DOM helpers ---------- */
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
