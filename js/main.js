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
                derr('You are on file:// — use a local server like http://localhost:5500 or similar.');
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

    function debugBadge(msg, sub = '') {
        let el = document.getElementById('dp-debug-badge');
        if (!el) {
            el = document.createElement('div');
            el.id = 'dp-debug-badge';
            Object.assign(el.style, {
                position: 'fixed', left: '12px', bottom: '12px', zIndex: 99999,
                padding: '8px 10px', background: '#7f1d1d', color: '#fff',
                font: '12px/1.2 system-ui, sans-serif', borderRadius: '8px',
                boxShadow: '0 6px 20px rgba(0,0,0,.35)', maxWidth: '46ch', whiteSpace: 'pre-wrap'
            });
            document.body.appendChild(el);
        }
        el.textContent = `[comments] ${msg}${sub ? '\n' + sub : ''}`;
    }

    async function httpProbe(url, opts = {}) {
        const t0 = performance.now();
        const label = `[probe] ${opts.method || 'GET'} ${url}`;
        console.groupCollapsed(label);
        try {
            console.log('options:', opts);
            const res = await fetch(url, opts);
            const text = await res.text();
            const ms = Math.round(performance.now() - t0);
            console.log('status:', res.status, res.statusText, `(${ms}ms)`);
            console.log('headers:', [...res.headers.entries()]);
            console.log('body:', text.slice(0, 400) + (text.length > 400 ? '…' : ''));
            console.groupEnd();
            return { ok: res.ok, status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
        } catch (err) {
            console.groupEnd();
            console.error(label, 'NETWORK ERROR:', err);
            throw err;
        }
    }

    async function mountCommentsForPlea(pleaNum) {
        console.groupCollapsed('%cCOMMENTS: mount (vendor or fallback)', 'color:#3b82f6;font-weight:600');
        try {
            // 1) Load optional vendor lib + init
            await loadCommentsLib().catch(() => { });
            if (window.DP?.init) window.DP.init({ apiBase: API_BASE });

            // 2) Host below the plea
            const containerEl = document.querySelector('.container') || document.body;
            document.querySelectorAll('#dp-comments-host, #dp-comments-wrap').forEach(n => n.remove());
            const wrap = document.createElement('div');
            wrap.id = 'dp-comments-wrap';
            wrap.className = containerEl.className || 'container';
            containerEl.insertAdjacentElement('afterend', wrap);
            const host = document.createElement('div');
            host.id = 'dp-comments-host';
            wrap.appendChild(host);

            // 3) CSS (narrow column + pager centering + fallback styles)
            if (!document.getElementById('dp-comments-fb-css')) {
                const s = document.createElement('style');
                s.id = 'dp-comments-fb-css';
                s.textContent = `
#dp-comments-host{
  --dp-header-size:22px; --dp-comment-header-size:13px; --dp-content-size:17px;
  --dp-actions-size:14px; --dp-viewmore-size:15px; --dp-post-size:15px; --dp-composer-size:16px;
  --dp-gap-header-body:10px; --dp-gap-body-actions:14px; --dp-gap-between-items:22px; --dp-max-width:640px;
}
#dp-comments-wrap{display:block;width:100%;clear:both;margin-top:28px;grid-column:1/-1;}
#dp-comments-host{display:block;width:100%;}
#dp-comments-host .dp-comments,
#dp-comments-host .dp-c-panel,
#dp-comments-host .dp-list,
#dp-comments-host .dp-item,
#dp-comments-host .dp-c-composer,
#dp-comments-host .dp-fb,
#dp-comments-host .dp-fb-list{max-width:var(--dp-max-width);margin:0 auto;}
#dp-comments-host, #dp-comments-host *{
  font-family:'Voice1','Montserrat',system-ui,-apple-system,Segoe UI,Roboto,sans-serif!important;color:#fff!important;
}
#dp-comments-host .dp-c-panel{background:transparent!important;border:1px solid rgba(255,255,255,.12)!important;padding:12px;}
#dp-comments-host .dp-item{border-top:1px solid rgba(255,255,255,.12);padding-top:12px;margin-top:var(--dp-gap-between-items);}
#dp-comments-host .dp-c-title{font-size:var(--dp-header-size); text-align:center;}
#dp-comments-host .dp-meta{font-size:var(--dp-comment-header-size);text-align:center;margin-bottom:var(--dp-gap-header-body);}
#dp-comments-host .dp-body{font-size:var(--dp-content-size);margin-top:0;}
#dp-comments-host .dp-actions{margin-top:var(--dp-gap-body-actions);display:flex;justify-content:center;gap:8px;font-size:var(--dp-actions-size);}
#dp-comments-host .dp-actions .dp-btn{font-size:inherit;}
#dp-comments-host .dp-c-composer textarea{width:100%;font-size:var(--dp-composer-size);}
#dp-comments-host .dp-post{font-size:var(--dp-post-size);}

/* Pager centering (vendor + fallback) */
#dp-comments-host .dp-pager,
#dp-comments-host .dp-fb-pager{display:flex!important;justify-content:center!important;align-items:center!important;width:100%!important;text-align:center!important;margin-top:12px!important;gap:0!important;}
#dp-comments-host .dp-pager > *,
#dp-comments-host .dp-fb-pager > *{float:none!important;margin:0 auto!important;display:inline-flex!important;}
#dp-comments-host .dp-next,
#dp-comments-host .dp-loadmore,
#dp-comments-host .dp-fb-next{margin:0 auto!important;display:inline-flex!important;font-size:var(--dp-viewmore-size)!important;padding:6px 10px;border:1px solid rgba(255,255,255,.2);border-radius:8px;background:transparent;color:#fff;cursor:pointer}

/* Fallback UI */
#dp-comments-host .dp-fb-item{border-top:1px solid rgba(255,255,255,.12);padding-top:12px;margin-top:var(--dp-gap-between-items);}
#dp-comments-host .dp-fb-head{font-size:var(--dp-comment-header-size);text-align:center;margin-bottom:var(--dp-gap-header-body);opacity:.9}
#dp-comments-host .dp-fb-body{font-size:var(--dp-content-size);}
#dp-comments-host .dp-fb-actions{margin-top:var(--dp-gap-body-actions);display:flex;justify-content:center;gap:10px;font-size:var(--dp-actions-size);opacity:.95}
#dp-comments-host .dp-fb-replies{margin-top:10px;border-left:2px solid rgba(255,255,255,.15);padding-left:12px}
#dp-comments-host .dp-fb-reply{margin-top:12px;opacity:.95}
      `;
                document.head.appendChild(s);
            }

            // 4) Vendor widget (if available)
            let usedFallback = false;
            async function tryVendor() {
                if (!window.DP?.mountComments) return false;
                console.log('[comments][vendor] mounting…');
                const maybePromise = window.DP.mountComments(pleaNum, host);
                try { await Promise.resolve(maybePromise); } catch { }
                const toggle = host.querySelector?.('.dp-c-toggle');
                if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click?.();
                await new Promise(r => setTimeout(r, 200));
                const items = host.querySelectorAll?.('.dp-item');
                const lists = host.querySelectorAll?.('.dp-list, .dp-replies, .dp-thread');
                console.log('[comments][vendor] items:', items?.length || 0, 'lists:', lists?.length || 0);
                if ((items?.length || 0) > 0) {
                    host.querySelectorAll?.('.dp-pager')?.forEach(p => {
                        p.style.display = 'flex'; p.style.justifyContent = 'center'; p.style.alignItems = 'center';
                        const btn = p.querySelector('.dp-next, .dp-loadmore, button, a');
                        if (btn) { btn.style.margin = '0 auto'; btn.style.display = 'inline-flex'; btn.textContent = btn.textContent?.trim() || 'View more comments'; }
                    });
                    return true;
                }
                return false;
            }

            // 5) Fallback renderer (uses your API directly) — WITH "View replies (n)" TOGGLE
            async function fetchList(page = 1, page_size = 10) {
                const url = `${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments?sort=hottest&page=${page}&page_size=${page_size}`;
                const res = await diagFetch(url, { credentials: 'include' });
                const items = Array.isArray(res?.items) ? res.items : (Array.isArray(res) ? res : []);
                const total = Number.isFinite(res?.total) ? +res.total : items.length;
                return { items, total, page, page_size };
            }
            async function fetchReplies(parentId) {
                const candidates = [
                    `${API_BASE}/comments/${encodeURIComponent(parentId)}/replies`,
                    `${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments?parent_id=${encodeURIComponent(parentId)}`,
                    `${API_BASE}/pleas/${encodeURIComponent(pleaNum)}/comments/${encodeURIComponent(parentId)}/replies`,
                ];
                for (const u of candidates) {
                    try {
                        const r = await diagFetch(u, { credentials: 'include' });
                        const arr = Array.isArray(r?.items) ? r.items : (Array.isArray(r) ? r : null);
                        if (arr) return arr;
                    } catch { }
                }
                return [];
            }
            function el(tag, cls, txt) {
                const n = document.createElement(tag);
                if (cls) n.className = cls;
                if (txt != null) n.textContent = txt;
                return n;
            }

            async function renderFallback() {
                usedFallback = true;
                console.warn('[comments][fallback] vendor rendered nothing — switching to fallback UI.');

                const root = el('div', 'dp-fb');
                root.appendChild(el('h3', 'dp-c-title', 'Comments'));
                const listEl = el('div', 'dp-fb-list');
                root.appendChild(listEl);

                const pager = el('div', 'dp-fb-pager');
                pager.style.display = 'flex'; pager.style.justifyContent = 'center'; pager.style.alignItems = 'center';
                const nextBtn = el('button', 'dp-fb-next', 'View more comments');
                pager.appendChild(nextBtn);

                host.innerHTML = '';
                host.appendChild(root);
                host.appendChild(pager);

                let page = 1, page_size = 10, total = 0, loaded = 0;

                function centeredPagerVisibility(hasMore) {
                    pager.style.display = hasMore ? 'flex' : 'none';
                    nextBtn.style.margin = '0 auto';
                    nextBtn.style.display = 'inline-flex';
                }

                function normalAuthor(c) {
                    return (c?.author?.display_name || c?.author?.name || c?.user?.name || c?.username || 'Anonymous');
                }
                function normalBody(c) {
                    return (c?.body ?? c?.text ?? c?.content ?? '');
                }
                function normalTime(c) {
                    const iso = (c?.created_at ?? c?.createdAt ?? c?.timestamp ?? Date.now());
                    try { return new Date(iso).toLocaleString(); } catch { return ''; }
                }
                function normalId(c) {
                    return (c?.id ?? c?.comment_id ?? c?._id ?? null);
                }
                function normalReplyCount(c) {
                    const rc = (c?.reply_count ?? c?.replies_count ?? (Array.isArray(c?.replies) ? c.replies.length : 0) ?? 0);
                    return Number(rc) || 0;
                }

                async function addPage() {
                    const { items, total: t } = await fetchList(page, page_size);
                    total = t;
                    for (const c of items) {
                        const it = el('article', 'dp-fb-item');

                        const head = el('div', 'dp-fb-head', `${normalAuthor(c)} • ${normalTime(c)}`);
                        const body = el('div', 'dp-fb-body', normalBody(c));
                        const actions = el('div', 'dp-fb-actions');

                        const rc = normalReplyCount(c);
                        const repWrap = el('div', 'dp-fb-replies');
                        repWrap.style.display = 'none';
                        repWrap.dataset.loaded = 'false';

                        if (rc > 0) {
                            const toggle = el('button', 'dp-fb-replies-toggle dp-btn', `View replies (${rc})`);
                            toggle.addEventListener('click', async () => {
                                const expanded = repWrap.style.display !== 'none';
                                if (expanded) {
                                    repWrap.style.display = 'none';
                                    toggle.textContent = `View replies (${rc})`;
                                    return;
                                }
                                repWrap.style.display = '';
                                toggle.textContent = 'Hide replies';

                                if (repWrap.dataset.loaded !== 'true') {
                                    toggle.disabled = true;
                                    repWrap.innerHTML = '';
                                    repWrap.appendChild(el('div', 'dp-fb-reply', 'Loading replies…'));
                                    try {
                                        const parentId = normalId(c);
                                        const reps = await fetchReplies(parentId);
                                        repWrap.innerHTML = '';
                                        if (!reps.length) {
                                            repWrap.appendChild(el('div', 'dp-fb-reply', '(No replies)'));
                                        } else {
                                            for (const r of reps) {
                                                const rr = el('div', 'dp-fb-reply');
                                                rr.appendChild(el('div', 'dp-fb-head', `↳ ${normalTime(r)}`));
                                                rr.appendChild(el('div', 'dp-fb-body', normalBody(r)));
                                                repWrap.appendChild(rr);
                                            }
                                        }
                                        repWrap.dataset.loaded = 'true';
                                    } catch (e) {
                                        repWrap.innerHTML = '';
                                        repWrap.appendChild(el('div', 'dp-fb-reply', '(Failed to load replies)'));
                                    } finally {
                                        toggle.disabled = false;
                                    }
                                }
                            });
                            actions.appendChild(toggle);
                        }

                        it.append(head, body, actions, repWrap);
                        listEl.appendChild(it);
                        loaded++;
                    }

                    const hasMore = loaded < total && items.length === page_size;
                    centeredPagerVisibility(hasMore);
                    console.log(`[comments][fallback] page ${page} loaded ${loaded}/${total}`);
                }

                nextBtn.addEventListener('click', async () => {
                    nextBtn.disabled = true;
                    try { page += 1; await addPage(); } finally { nextBtn.disabled = false; }
                });

                await addPage();
            }

            // 6) Run vendor; if empty => fallback
            const ok = await tryVendor();
            if (!ok) await renderFallback();

            // 7) Expose minimal debug
            window.DP_DEBUG = { host, usedFallback: () => usedFallback };
            console.log('[comments] ready. usedFallback =', usedFallback);
        } catch (e) {
            console.error('Comments mount failed:', e);
        } finally {
            console.groupEnd();
        }
    }

    // Hard patch to keep pager centered even if vendor re-injects it later
    (function dpCommentsHardPatch() {
        const hostId = 'dp-comments-host';

        const STYLE_ID = 'dp-center-pager-and-debug';
        if (!document.getElementById(STYLE_ID)) {
            const s = document.createElement('style');
            s.id = STYLE_ID;
            s.textContent = `
#${hostId} .dp-pager,
#${hostId} .dp-fb-pager{
  display:grid !important;
  place-items:center !important;
  width:100% !important;
  text-align:center !important;
  margin-top:12px !important;
}
#${hostId} .dp-pager > *,
#${hostId} .dp-fb-pager > *{
  float:none !important;
  margin:0 auto !important;
  display:inline-flex !important;
}
#${hostId} .dp-next,
#${hostId} .dp-loadmore,
#${hostId} .dp-fb-next{
  margin:0 auto !important;
  display:inline-flex !important;
  font-size:inherit !important;
}
`;
            document.head.appendChild(s);
        }

        function centerPagers(root) {
            const pagers = root.querySelectorAll?.('.dp-pager, .dp-fb-pager');
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

        function logRepliesPresence(root, reason) {
            const containers = root.querySelectorAll('.dp-replies, .dp-thread, .dp-replies-inner, .dp-fb-replies');
            const toggles = root.querySelectorAll('.dp-toggle-replies, .dp-reply-toggle, [data-action="toggle-replies"], [class*="repl"], .dp-fb-replies-toggle');
            const items = root.querySelectorAll('.dp-reply, [data-reply-id], .dp-fb-reply');
            const visible = [...containers].filter(el => getComputedStyle(el).display !== 'none');
            console.log('[comments][replies-debug]', { reason, toggles: toggles.length, containers: containers.length, visible: visible.length, items: items.length });
        }

        function boot() {
            const host = document.getElementById(hostId);
            if (!host) { setTimeout(boot, 100); return; }
            centerPagers(host);
            logRepliesPresence(host, 'initial');

            const mo = new MutationObserver(muts => {
                let touched = false;
                for (const m of muts) { if (m.addedNodes && m.addedNodes.length) { touched = true; break; } }
                if (!touched) return;
                centerPagers(host);
                logRepliesPresence(host, 'mutation');
            });
            mo.observe(host, { childList: true, subtree: true });

            setTimeout(() => { centerPagers(host); logRepliesPresence(host, 't200'); }, 200);
            setTimeout(() => { centerPagers(host); logRepliesPresence(host, 't1000'); }, 1000);
        }

        boot();
        window.__DP_FORCE_CENTER = () => {
            const host = document.getElementById(hostId);
            if (host) { centerPagers(host); logRepliesPresence(host, 'manual'); }
        };

        // Optional small probe
        try {
            const PLEA_NUM = (location.pathname.match(/\/(\d{1,6})\/?$/) || [])[1];
            const API_BASE = (document.querySelector('meta[name="dp:api"]')?.content) || 'http://localhost:3000/api';
            if (PLEA_NUM) fetch(`${API_BASE}/pleas/${encodeURIComponent(PLEA_NUM)}/comments?sort=hottest&page=1&page_size=10`, { credentials: 'include' })
                .then(r => r.json()).then(j => {
                    const rc = (Array.isArray(j?.items) ? j.items : []).map(c => ({ id: c.id, reply_count: c.reply_count }));
                    console.log('[comments][api] top-level:', rc);
                }).catch(() => { });
        } catch { }
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
