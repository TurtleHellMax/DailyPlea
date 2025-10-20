(() => {
    const API = 'http://localhost:3000/api';
    const $ = (id) => document.getElementById(id);

    // Reuse the existing MessagesApp + state instead of clobbering it
    const MA = (window.MessagesApp = window.MessagesApp || {});
    const state = (MA.state = MA.state || {});

    // ----- state (send/UI control intentionally absent) -----
    state.convId ??= null;
    state.meId ??= 0;
    state.allConvs ??= [];
    state.filteredConvs ??= [];
    state.lastMsgId ??= 0;
    state.oldestMsgId ??= null;
    state.nextBefore ??= null;
    state.es ??= null;
    state.esGlobal ??= null;
    state.poll ??= null;

    // File/recording/state buckets (no gating logic here)
    state.pendingFiles ??= [];
    state.uploadingCount ??= 0;           // maintained by other modules; no UI logic here
    state.uploading = !!state.uploading;  // legacy boolean; not used for UI here

    state.recording ??= { active: false, chunks: [], size: 0, rec: null, warnShown: false, mime: '' };
    state.convMeta ??= new Map();
    state.convRowEls ??= new Map();
    state.convUserOg ??= new Map();
    state.userCache ??= new Map();
    state.convItems ??= new Map();
    state.audioPlayers ??= new Map();
    state.msgColorsByConv ??= new Map();
    state.convDetailById ??= new Map();
    state.currentConvDetail ??= null;
    state.renderedMsgIds ??= new Set();
    state.fetchingAfter = !!state.fetchingAfter;
    state.meSlug ??= '';

    // ---------- constants & tiny utils ----------
    const LASTDM_KEY = 'dp:lastdm';
    const META_CACHE_KEY = 'dp:metaCache';
    const HIDE_BEFORE_KEY = 'dp:hideBefore';
    const DEFAULT_PFP_DM = '/web/default-avatar.png';
    const DEFAULT_PFP_GROUP = '/web/default-groupavatar.png';
    const MAX_BYTES = 1024 * 1024;
    const GROUP_COLORS = [
        { key: 'blue', val: '#3b82f6' },
        { key: 'green', val: '#22c55e' },
        { key: 'purple', val: '#a855f7' },
        { key: 'orange', val: '#f97316' },
        { key: 'pink', val: '#ec4899' },
        { key: 'teal', val: '#14b8a6' },
        { key: 'yellow', val: '#eab308' },
        { key: 'red', val: '#ef4444' },
    ];
    const GROUP_COLOR_BY_KEY =
        Object.fromEntries(GROUP_COLORS.map(c => [String(c.key).toLowerCase(), String(c.val).toLowerCase()]));

    function normalizeGroupColor(input) {
        if (!input) return null;
        const s = String(input).trim().toLowerCase();
        if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).split('').map(x => x + x).join('');
        if (/^#[0-9a-f]{6}$/.test(s)) return s;
        return GROUP_COLOR_BY_KEY[s] || null;   // map 'blue' -> '#3b82f6'
    }

    function pickGroupColor(want) {
        const hex = normalizeGroupColor(want);
        if (hex) return hex;
        const all = GROUP_COLORS.map(c => String(c.val).toLowerCase());
        return all[(Math.random() * all.length) | 0];
    }

    let _metaSaveTimer = null;
    const afterPaint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const esc = (s) => String(s || '').replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
    const fmt = (t) => { try { return new Date(t).toLocaleString(); } catch { return ''; } };
    const nearBottom = (px = 60) => { const el = $('msgs'); return (el.scrollHeight - el.scrollTop - el.clientHeight) < px; };
    const scrollToBottom = () => { const el = $('msgs'); el.scrollTop = el.scrollHeight + 9999; };

    const pickUsername = o => o?.first_username || o?.username || o?.handle || null;
    const pickPhoto = o => o?.profile_photo || o?.profile_photo_url || o?.photo || o?.photo_url || o?.avatar || o?.avatar_url || o?.picture || o?.image || o?.image_url || null;
    const pickName = o => o?.display_name || o?.name || o?.username || o?.first_username || o?.handle || o?.title || null;

    function saveLastDM() {
        try { localStorage.setItem(LASTDM_KEY, JSON.stringify({ meId: state.meId | 0, convId: state.convId | 0, at: Date.now() })) } catch { }
    }
    function loadLastDM() {
        try { return JSON.parse(localStorage.getItem(LASTDM_KEY) || 'null'); } catch { return null; }
    }

    function _getHideMap() { try { return JSON.parse(localStorage.getItem(HIDE_BEFORE_KEY) || '{}'); } catch { return {}; } }
    function _setHideMap(m) { try { localStorage.setItem(HIDE_BEFORE_KEY, JSON.stringify(m)); } catch { } }
    const getHideBeforeId = (cid) => (_getHideMap()[cid] | 0);
    function setHideBeforeId(cid, id) { const m = _getHideMap(); m[cid] = id | 0; _setHideMap(m); }
    function clearHideBeforeId(cid) { const m = _getHideMap(); delete m[cid]; _setHideMap(m); }
    function filterHidden(items, cid = state.convId) {
        const cut = getHideBeforeId(cid) | 0; if (!cut) return items || [];
        return (items || []).filter(m => (m.id | 0) > cut);
    }

    function joinNames(arr) {
        const a = (arr || []).filter(Boolean);
        if (!a.length) return 'Group';
        if (a.length === 1) return a[0];
        if (a.length === 2) return a[0] + ' & ' + a[1];
        return a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1];
    }
    const labelForMember = u => pickName(u) || 'user';
    const computeDefaultGroupTitle = members => joinNames((members || []).map(labelForMember));

    function saveMetaCache() {
        const out = {
            convUserOg: Array.from(state.convUserOg.entries()),
            userCache: Array.from(state.userCache.entries()),
            convMeta: Array.from(state.convMeta.entries()),
        };
        try { localStorage.setItem(META_CACHE_KEY, JSON.stringify(out)); } catch { }
    }
    function scheduleSaveMeta() { clearTimeout(_metaSaveTimer); _metaSaveTimer = setTimeout(saveMetaCache, 120); }
    function loadMetaCache() {
        try {
            const j = JSON.parse(localStorage.getItem(META_CACHE_KEY) || 'null');
            if (!j) return;
            (j.convUserOg || []).forEach(([k, v]) => state.convUserOg.set(+k || k, v));
            (j.userCache || []).forEach(([k, v]) => state.userCache.set(k, v));
            (j.convMeta || []).forEach(([k, v]) => state.convMeta.set(+k || k, v));
        } catch { }
    }

    function errMsg(e) {
        if (typeof e === 'string') return e;
        if (e?.message) return e.message;
        if (e?.detail) return e.detail;
        try { return JSON.stringify(e); } catch { return String(e); }
    }

    // ---------- API ----------
    async function api(path, opts = {}) {
        const headers = Object.assign({ 'Accept': 'application/json' }, opts.headers || {});
        const hasBody = opts.body !== undefined && opts.body !== null;
        const isForm = hasBody && (opts.body instanceof FormData);
        const isString = hasBody && (typeof opts.body === 'string');

        // describe body before we transform it
        const _describeBody = (b) => {
            if (!b) return null;
            if (b instanceof FormData) {
                const fields = {};
                try { b.forEach((v, k) => { fields[k] = (typeof v === 'string') ? v : '[Blob/File]'; }); } catch { }
                return { type: 'FormData', fields };
            }
            if (typeof b === 'string') return { type: 'string', length: b.length, preview: b.slice(0, 120) };
            try { return { type: 'json', keys: Object.keys(b) }; } catch { return { type: typeof b }; }
        };
        const bodyDesc = _describeBody(opts.body);

        if (hasBody && !isForm && !isString && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        const body = !hasBody
            ? undefined
            : isForm
                ? opts.body
                : isString
                    ? opts.body
                    : JSON.stringify(opts.body);

        const url = API + path;
        const method = (opts.method || 'GET').toUpperCase();
        const t0 = performance.now();
        GDBG.log('api:request', { method, url, headers: Object.keys(headers), body: bodyDesc });

        const r = await fetch(url, {
            credentials: 'include',
            method,
            headers,
            body
        });

        const dt = Math.round(performance.now() - t0);
        const text = await r.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

        GDBG.log('api:response', {
            method, url, status: r.status, ok: r.ok, ms: dt,
            json_keys: (data && typeof data === 'object') ? Object.keys(data) : []
        });

        if (!r.ok) {
            const e = new Error(data?.error || r.statusText);
            e.status = r.status;
            e.detail = data?.detail || text;
            GDBG.err('api:error', { method, url, status: r.status, detail: e.detail });
            throw e;
        }

        /* ---- NEW: post-response color seeding hooks ---- */
        try {
            // 1) Group just created
            if (method === 'POST' && /\/dm\/conversations$/.test(url) && (data?.id || data?.conversation_id)) {
                const cid = data.id || data.conversation_id;
                // Prefer whatever color the creator intended; if none, we’ll pick
                const prefer = (typeof (opts?.body)?.color === 'string' && (opts.body).color) || null;
                GDBG.log('ensureColor:postCreate', { cid, prefer });
                ensureGroupHasColor(cid, prefer);
            }

            // 2) List loaded: backfill any owner groups with missing color
            if (method === 'GET' && /\/dm\/conversations(\?.*)?$/.test(url) && Array.isArray(data?.items)) {
                const items = data.items.filter(it => it?.is_group && !it?.color);
                if (items.length) GDBG.log('ensureColor:listScan', { count: items.length });
                // Do a light-touch pass: we’ll check owner/hasColor inside ensureGroupHasColor
                for (const it of items) ensureGroupHasColor(it.id);
            }
        } catch (e) {
            GDBG.warn('ensureColor:hook error', errMsg(e));
        }
        /* ---- end hook ---- */

        return data;
    }

    async function getMe() {
        const j = await api('/auth/me');
        state.meId = j?.user?.id || 0;
        state.meSlug = j?.user?.first_username || j?.user?.username || '';
        return state.meId;
    }

    async function fetchMsgColors(cid) {
        const j = await api(`/dm/conversations/${cid}/message_colors`);
        return j?.colors || {};
    }
    const setMyMsgColor = (cid, color) =>
        api(`/dm/conversations/${cid}/message_colors/me`, { method: 'PATCH', body: { color } });
    const patchMsgColors = (cid, colors) =>
        api(`/dm/conversations/${cid}/message_colors`, { method: 'PATCH', body: { colors } });

    const setColorMap = (cid, map) => state.msgColorsByConv.set(cid, map || {});
    const getColorMap = (cid) => state.msgColorsByConv.get(cid) || {};

    // === Randomize just *my* message color (self-serve endpoint) =================
    async function randomizeMyMsgColor(conversationId = state.convId) {
        const cid = conversationId | 0;
        const me = state.meId | 0;
        if (!cid || !me) throw new Error('randomizeMyMsgColor: missing convId or meId');

        // Build a "seen" set so we pick something distinct from palette + current map
        const curMap = getColorMap(cid) || {};
        const seen = new Set(
            Object.values(curMap).filter(Boolean).map(s => String(s).toLowerCase())
        );
        (GROUP_COLORS || []).forEach(c => c?.val && seen.add(String(c.val).toLowerCase()));

        // Prefer your existing unique-hex helper; fall back to pure random
        const randHex = () => ('#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')).toLowerCase();
        const hex = (typeof _pickUniqueHex === 'function') ? _pickUniqueHex(seen) : randHex();

        // Optimistic local update
        const next = { ...curMap, [me]: hex };
        setColorMap(cid, next);
        updateAllMessageBorders();

        // Persist via the *same* endpoint as the overlay
        try {
            await setMyMsgColor(cid, hex); // -> PATCH /dm/conversations/:cid/message_colors/me
        } finally {
            // Ensure UI matches server truth
            try { await syncMsgColors(cid, { retry: 1, backoff: 150 }); } catch { }
        }
        return hex;
    }

    async function syncMsgColors(cid, { retry = 0, backoff = 300 } = {}) {
        try {
            let map = await fetchMsgColors(cid);
            let tries = retry, delay = backoff;
            while ((!map || Object.keys(map).length === 0) && tries-- > 0) {
                await new Promise(r => setTimeout(r, delay));
                delay *= 2;
                map = await fetchMsgColors(cid);
            }
            setColorMap(cid, map || {});
            updateAllMessageBorders();
            return map || {};
        } catch {
            setColorMap(cid, {});
            return {};
        }
    }

    function chooseUniqueColorsForUsers(userIds, existingMap = {}) {
        const used = new Set(Object.values(existingMap || {}));
        const palette = GROUP_COLORS.map(c => c.val);
        const available = palette.filter(c => !used.has(c));
        const out = {};
        for (const uid of userIds) {
            if (existingMap[uid]) continue;
            const color = available.length
                ? available.splice((Math.random() * available.length) | 0, 1)[0]
                : palette[(Math.random() * palette.length) | 0];
            out[uid] = color; used.add(color);
        }
        return out;
    }

    function updateAllMessageBorders() {
        const cmap = getColorMap(state.convId);
        const nodes = document.querySelectorAll('#msgs .msg:not(.sysmsg)');
        let setCount = 0, unsetCount = 0;
        nodes.forEach(el => {
            const uid = +el.dataset.senderId || 0;
            const col = cmap[uid] || null;
            if (col) { el.style.setProperty('--mbc', col); setCount++; }
            else { el.style.removeProperty('--mbc'); unsetCount++; }
        });
        GDBG.log('borders:update', {
            convId: state.convId, nodes: nodes.length, setCount, unsetCount,
            usersWithColors: Object.keys(cmap || {}).length
        });
    }

    const GDBG = {
        on: true, // flip to false to silence
        log(...a) { try { this.on && console.debug('[groups]', ...a); } catch { } },
        warn(...a) { try { this.on && console.warn('[groups]', ...a); } catch { } },
        err(...a) { try { this.on && console.error('[groups]', ...a); } catch { } },
    };

    // ===== GROUP CREATION + AUTO-TITLE (core.js) =====

    // Build "A & B" or "A, B & C" (already in your utils, but we depend on it here)
    // Normalize a server "members" list across shapes and exclude "me" by default
    function _normalizeMembers(raw, { excludeMe = true } = {}) {
        const me = (window.MessagesApp?.state?.meId | 0) || 0;
        const arr = (raw || []);
        // tolerate: [user], [{user}], {users:[]}, {participants:[]}, {people:[]}
        const list = Array.isArray(arr) ? arr
            : (arr.users || arr.members || arr.participants || arr.people || arr.items || []);
        const flat = list.map(m => m?.user || m?.member || m).filter(Boolean);
        return excludeMe ? flat.filter(u => ((u.id | 0) !== me)) : flat;
    }

    const _pickName = o =>
        (window.MessagesApp?.utils?.pickName?.(o)) ||
        o?.display_name || o?.name || o?.username || o?.first_username || o?.handle || 'user';

    function computeMemberListTitle(members, { excludeMe = true } = {}) {
        const flat = _normalizeMembers(members, { excludeMe });
        const seen = new Set();
        const names = flat
            .map(_pickName)
            .map(s => String(s || '').replace(/^@+/, '').trim())
            .filter(Boolean)
            .filter(n => { const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });

        if (names.length === 0) return 'Group';
        if (names.length === 1) return names[0];
        if (names.length === 2) return `${names[0]} & ${names[1]}`;
        return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
    }

    const _joinNames = (arr) => {
        const a = (arr || []).filter(Boolean);
        if (!a.length) return 'Group';
        if (a.length === 1) return a[0];
        if (a.length === 2) return a[0] + ' & ' + a[1];
        return a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1];
    };

    // --- helpers: random unique #rrggbb not in reserved/seen ---
    function _randHex() {
        return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    }
    function _pickUniqueHex(seen) {
        let tries = 0;
        while (tries++ < 200) {
            const h = _randHex().toLowerCase();
            if (!seen.has(h)) return h;
        }
        // worst-case fallback
        return _randHex().toLowerCase();
    }

    // --- assign + persist non-palette colors for all members (owner-only endpoint) ---
    async function assignRandomMemberColors(conversationId) {
        const cid = conversationId | 0;
        if (!cid) throw new Error('assignRandomMemberColors: missing conversationId');

        // get members + current colors
        const conv = await _apiGet(`/dm/conversations/${cid}`);
        const memberIds = (conv?.members || []).map(u => +u.id).filter(Boolean);
        if (!memberIds.length) return {};

        // reserve the palette (and optionally the group color)
        const reserved = new Set(GROUP_COLORS.map(c => c.val.toLowerCase()));
        if (conv?.color) reserved.add(String(conv.color).toLowerCase());

        const seen = new Set(reserved);
        const colors = {};
        for (const uid of memberIds) {
            const hex = _pickUniqueHex(seen);
            seen.add(hex);
            colors[uid] = hex;               // server expects "#rrggbb"
        }

        // persist on server (owner-only) and update local UI
        await patchMsgColors(cid, colors);
        const existing = getColorMap(cid);
        setColorMap(cid, { ...existing, ...colors });
        updateAllMessageBorders();

        // optional: confirm from server
        try { await syncMsgColors(cid, { retry: 1, backoff: 150 }); } catch { }
        return colors;
    }

    function _pickGroupColorEntry() {
        const arr = (GROUP_COLORS || []);
        return arr.length ? arr[(Math.random() * arr.length) | 0] : { key: null, val: null };
    }
    function _normalizeGroupColorEntry(want) {
        const arr = GROUP_COLORS || [];
        if (!arr.length) return { key: null, val: null };
        if (!want) return _pickGroupColorEntry();
        const s = String(want).trim().toLowerCase();
        const found = arr.find(c => c.key === s || String(c.val).toLowerCase() === s);
        return found || _pickGroupColorEntry();
    }

    function applyGroupColorToRow(cid, hex) {
        try {
            const row = state.convRowEls?.get?.(cid) || null;
            if (row && hex) {
                row.style.setProperty('--group-color', hex);
                GDBG.log('row:applyGroupColor', { cid, hex, ok: true });
            } else {
                GDBG.log('row:applyGroupColor', { cid, hex, ok: false, reason: row ? 'no-hex' : 'no-row' });
            }
        } catch (e) {
            GDBG.warn('row:applyGroupColor:fail', errMsg(e));
        }
    }

    const _ensuringColor = new Set();
    async function ensureGroupHasColor(cid, preferHex = null) {
        const id = cid | 0;
        const hex = normalizeGroupColor(preferHex) || pickGroupColor();
        GDBG.log('ensureColor:set -> PATCH', { id, hex });
        await setGroupColor(id, hex);
        applyGroupColorToRow(id, hex);
        GDBG.log('ensureColor:ok', { id, hex });
    }

    async function _apiGet(path) {
        GDBG.log('GET', path);
        const r = await window.MessagesApp.api.api(path, { method: 'GET' });
        GDBG.log('GET ok', path, { keys: Object.keys(r || {}) });
        return r;
    }
    async function _apiPost(path, body) {
        GDBG.log('POST', path, body);
        const r = await window.MessagesApp.api.api(path, { method: 'POST', body });
        GDBG.log('POST ok', path, { keys: Object.keys(r || {}) });
        return r;
    }
    async function _apiPatch(path, body) {
        GDBG.log('PATCH', path, body);
        const r = await window.MessagesApp.api.api(path, { method: 'PATCH', body });
        GDBG.log('PATCH ok', path, { keys: Object.keys(r || {}) });
        return r;
    }

    function _isGenericTitle(s) {
        const t = String(s || '').trim().toLowerCase();
        return !t || t === 'group' || t === 'new group' || t === 'untitled group';
    }

    async function setGroupTitle(conversationId, title) {
        const cid = conversationId | 0;
        const t = String(title || '').trim();
        if (!cid) throw new Error('setGroupTitle: missing conversationId');
        if (!t) throw new Error('setGroupTitle: empty title');

        await window.MessagesApp.api.api(`/dm/conversations/${cid}/title`, {
            method: 'PATCH',
            body: { title: t }
        });

        // update local UI
        const prev = state.convMeta?.get?.(cid) || {};
        const next = { ...prev, name: t, is_group: true, auto_title: false };
        state.convMeta?.set?.(cid, next);
        state.convItems?.set?.(cid, { id: cid, is_group: true, title: next.name, preview: '', color: next.color || prev.color || null });
        scheduleSaveMeta?.();
        return t;
    }

    async function setGroupColor(conversationId, color) {
        const cid = conversationId | 0;
        if (!cid) throw new Error('setGroupColor: missing conversationId');

        const input = String(color ?? '').trim();
        const hex = normalizeGroupColor(input);
        if (!hex) throw new Error(`setGroupColor: bad color "${input}" (use #rgb/#rrggbb or a known key)`);

        console.groupCollapsed('[groups] setGroupColor', { cid, input, normalized: hex });

        // ---- canonical endpoint (owner-only) ----
        const fd = new FormData();
        fd.append('color', hex); // server only reads "color"
        await window.MessagesApp.api.api(`/dm/conversations/${cid}/appearance`, {
            method: 'PATCH',
            body: fd
        });

        // Optimistic UI state update
        const prev = state.convMeta?.get?.(cid) || {};
        const next = { ...prev, color: hex, is_group: true };
        state.convMeta?.set?.(cid, next);
        state.convItems?.set?.(cid, { id: cid, is_group: true, title: next.name || prev.name || 'Group', preview: '', color: hex });
        scheduleSaveMeta?.();
        applyGroupColorToRow(cid, hex);

        // Update top bar if this convo is open
        try {
            if ((state.convId | 0) === cid && typeof updateTopBar === 'function') updateTopBar(next);
        } catch (e) {
            GDBG?.warn?.('topbar:updateTopBar error', errMsg(e));
        }

        // Optional: refresh per-user message border colors (map lives server-side)
        try { await syncMsgColors(cid, { retry: 1, backoff: 150 }); } catch { }

        console.groupEnd();
        return hex;
    }

    function _safe(o, path, fallback = null) {
        try { return path.split('.').reduce((a, k) => a?.[k], o) ?? fallback; } catch { return fallback; }
    }

    async function debugDumpColor(cid = state.convId) {
        const id = cid | 0;
        const meta = state.convMeta?.get?.(id) || {};
        const item = state.convItems?.get?.(id) || {};
        const cmap = getColorMap(id);
        const rowEl = state.convRowEls?.get?.(id) || null;
        const rowVar = rowEl ? getComputedStyle(rowEl).getPropertyValue('--group-color') : null;
        const msgs = document.querySelectorAll('#msgs .msg:not(.sysmsg)');
        const sample = msgs[0] ? getComputedStyle(msgs[0]).getPropertyValue('--mbc') : null;
        console.table({
            convId: id,
            meta_color: meta.color || null,
            list_item_color: item.color || null,
            users_with_msg_colors: Object.keys(cmap || {}).length,
            rowEl_present: !!rowEl,
            row_css_var: rowVar || '(none)',
            sample_msg_mbc: sample || '(none)'
        });
        try {
            const conv = await _apiGet(`/dm/conversations/${id}`);
            console.log('server conversation color candidates', {
                color: conv?.color,
                group_color: conv?.group_color,
                appearance_color: _safe(conv, 'appearance.color'),
                settings_color: _safe(conv, 'settings.color'),
                meta_color: _safe(conv, 'meta.color')
            });
        } catch (e) {
            console.warn('debugDumpColor: server read failed', e?.status, e?.message);
        }
    }

    async function debugVerifyColor(cid = state.convId, expectHex) {
        const id = cid | 0;
        const hex = expectHex || (state.convMeta?.get?.(id)?.color ?? '(unknown)');
        await debugDumpColor(id);
        console.log('expecting color =', hex);
    }

    // convenience: set both; only calls endpoints you need
    async function setGroupTitleAndColor(conversationId, { title, color } = {}) {
        const out = { id: conversationId | 0 };
        if (title != null && String(title).trim() !== '') out.title = await setGroupTitle(conversationId, title);
        if (color != null && String(color).trim() !== '') out.color = await setGroupColor(conversationId, color);
        return out;
    }

    async function createGroup(userIds, opts = {}) {
        if (!Array.isArray(userIds) || userIds.length < 2) {
            throw new Error('createGroup: pass userIds (Array) of at least 2 users');
        }

        // title: prefer provided, else compute ("A & B & C")
        const meId = (window.MessagesApp?.state?.meId | 0) || 0;
        const cachedUsers = (window.MessagesApp?.state?.userCache) || new Map();
        const names = userIds
            .concat(meId)
            .map(id => cachedUsers.get(id) || { id, username: String(id) })
            .map(u => (window.MessagesApp?.utils?.pickName?.(u)) || u.display_name || u.name || u.username || u.first_username || u.handle || String(u.id));
        const computed = (function join(a) {
            const uniq = Array.from(new Set(a.map(s => String(s || '').replace(/^@+/, '').trim()).filter(Boolean)));
            if (!uniq.length) return 'Group';
            if (uniq.length === 1) return uniq[0];
            if (uniq.length === 2) return `${uniq[0]} & ${uniq[1]}`;
            return `${uniq.slice(0, -1).join(', ')} & ${uniq[uniq.length - 1]}`;
        })(names);
        const wantedTitle = String(opts.title || opts.name || computed).trim() || 'Group';

        // color: normalize or pick now; we’ll *enforce* it post-create
        const colorHex = normalizeGroupColor(opts.color) || pickGroupColor();

        // Create group (many servers ignore color here — that’s OK)
        const res = await _apiPost('/dm/conversations', {
            user_ids: userIds,
            title: wantedTitle,
            color: colorHex,
            group_color: colorHex
        });

        const cid = res?.conversation_id || res?.id;
        if (!cid) throw new Error('createGroup: server did not return conversation id');

        try {
            const allMemberIds = Array.from(new Set([...userIds, meId])); // include me
            const randHex = () => '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');

            const colorMap = {};
            for (const uid of allMemberIds) colorMap[uid] = randHex();

            await patchMsgColors(cid, colorMap);                 // persist on server
            setColorMap(cid, { ...getColorMap(cid), ...colorMap }); // update local cache
            updateAllMessageBorders();                           // reflect if thread open
            GDBG.log('createGroup: member colors set', colorMap);
        } catch (e) {
            GDBG.warn('createGroup: set member colors failed', errMsg(e));
        }

        // Seed local UI immediately
        const seedMeta = {
            name: wantedTitle,
            photo: DEFAULT_PFP_GROUP,
            is_group: true,
            color: colorHex,
            auto_title: true
        };
        state.convMeta?.set?.(cid, seedMeta);
        state.convItems?.set?.(cid, { id: cid, is_group: true, title: seedMeta.name, preview: '', color: seedMeta.color });
        scheduleSaveMeta?.();

        // Apply CSS var to the list row if it exists already
        applyGroupColorToRow(cid, colorHex);

        // **Enforce** color on servers that ignored it during create
        try {
            await setGroupColor(cid, colorHex);
            GDBG.log('createGroup:post-setColor ok', { cid, colorHex });
        } catch (e) {
            GDBG.warn('createGroup:post-setColor failed (continuing)', { cid, status: e?.status, msg: e?.message });
        }
        try {
            await assignRandomMemberColors(cid);
            GDBG.log('createGroup:random member colors applied');
        } catch (e) {
            GDBG.warn('createGroup:assignRandomMemberColors failed', errMsg(e));
        }

        try {
            if (method === 'POST' && /\/dm\/conversations$/.test(url) && (data?.id || data?.conversation_id)) {
                const cid = data.id || data.conversation_id;
                const prefer = (typeof (opts?.body)?.color === 'string' && (opts.body).color) || null;
                GDBG.log('ensureColor:postCreate', { cid, prefer });

                // keep these two – group color + per-member colors
                ensureGroupHasColor(cid, prefer).catch(e => GDBG.warn('ensureColor failed', errMsg(e)));
                assignRandomMemberColors(cid).catch(e => GDBG.warn('seed member colors failed', errMsg(e))); // <-- ADD THIS
            }

            if (method === 'GET' && /\/dm\/conversations(\?.*)?$/.test(url) && Array.isArray(data?.items)) {
                const items = data.items.filter(it => it?.is_group && !it?.color);
                for (const it of items) ensureGroupHasColor(it.id).catch(() => { });
            }
        } catch (e) {
            GDBG.warn('ensureColor:hook error', errMsg(e));
        }
        return { conversation_id: cid, id: cid, title: wantedTitle, color: colorHex };
    }

    async function renameGroupToMembers(conversationId) {
        if (!conversationId) throw new Error('renameGroupToMembers: missing conversationId');
        const conv = await _apiGet(`/dm/conversations/${conversationId}`);
        const title = (conv?.title || '').trim();
        const desired = computeMemberListTitle(conv, { excludeMe: false });
        GDBG.log('renameGroupToMembers:no-op', { conversationId, serverTitle: title, desired });
        // Reflect desired in local UI only (no server write)
        try {
            const prev = state.convMeta?.get?.(conversationId) || {};
            const nextTitle = _isGenericTitle(title) ? desired : title;
            state.convMeta?.set?.(conversationId, { ...prev, name: nextTitle, auto_title: true });
            scheduleSaveMeta?.();
            return nextTitle;
        } catch { return title || desired; }
    }

    // ---- export a tiny surface you can call from chat.js (after you strip its old creation code)
    window.MessagesApp.groups = Object.assign(window.MessagesApp.groups || {}, {
        create: createGroup,
        setTitle: setGroupTitle,
        setColor: setGroupColor,
        setTitleAndColor: setGroupTitleAndColor,
        renameToMembers: renameGroupToMembers,
        reseedMemberColors: assignRandomMemberColors,
        computeMemberListTitle,
        debugDumpColor,
        randomizeMyMsgColor,
        debugVerifyColor
    });

    window.randomizeMyColor = () =>
        window.MessagesApp.api.randomizeMyMsgColor()
            .then(hex => console.log('my color ->', hex))
            .catch(console.error);

    // expose (no send-button or gate APIs here)
    window.MessagesApp = Object.assign(window.MessagesApp || {}, {
        API, $, state,
        DEFAULT_PFP_DM, DEFAULT_PFP_GROUP, MAX_BYTES, GROUP_COLORS,
        utils: {
            afterPaint, esc, fmt, nearBottom, scrollToBottom, errMsg,
            pickUsername, pickPhoto, pickName,
            joinNames, labelForMember, computeDefaultGroupTitle,
            saveLastDM, loadLastDM,
            getHideBeforeId, setHideBeforeId, clearHideBeforeId, filterHidden,
            saveMetaCache, scheduleSaveMeta, loadMetaCache,
            updateAllMessageBorders, normalizeGroupColor, pickGroupColor
        },
        api: {
            api, getMe, fetchMsgColors, setMyMsgColor, patchMsgColors,
            setColorMap, getColorMap, syncMsgColors, chooseUniqueColorsForUsers
        }
    });
})();
