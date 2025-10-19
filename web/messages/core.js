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
        const r = await fetch(url, {
            credentials: 'include',
            method: opts.method || 'GET',
            headers,
            body
        });
        const t = await r.text();
        let d; try { d = t ? JSON.parse(t) : {} } catch { d = { raw: t } }
        if (!r.ok) {
            const e = new Error(d?.error || r.statusText);
            e.status = r.status;
            e.detail = d?.detail || t;
            throw e;
        }
        return d;
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
        document.querySelectorAll('.msgs .msg:not(.sysmsg)').forEach(el => {
            const uid = +el.dataset.senderId || 0;
            const col = cmap[uid] || null;
            if (col) el.style.setProperty('--mbc', col);
            else el.style.removeProperty('--mbc');
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

    function _pickGroupColor() {
        const palette = (GROUP_COLORS || []).map(c => c.val).filter(Boolean);
        return palette.length ? palette[(Math.random() * palette.length) | 0] : null;
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

    async function createGroup(userIds, opts = {}) {
        if (!Array.isArray(userIds) || userIds.length < 2) {
            throw new Error('createGroup: pass userIds (Array) of at least 2 users');
        }
        const color = opts.color || _pickGroupColor();
        GDBG.log('createGroup:start', { userIds, color });

        // 1) create
        const res = await _apiPost('/dm/conversations', { user_ids: userIds, color });
        const cid = res?.conversation_id || res?.id;
        if (!cid) {
            GDBG.err('createGroup:no-id', res);
            throw new Error('createGroup: server did not return conversation id');
        }

        // Prefer embedded conversation if provided; otherwise fetch it.
        let conv = res?.conversation;
        if (!conv) {
            conv = await _apiGet(`/dm/conversations/${cid}`);
        }
        GDBG.log('createGroup:created', { cid, hasMembers: !!(conv?.members || conv?.users || conv?.participants) });

        // 2) compute desired title from members (excluding me)
        const desired = computeMemberListTitle(conv, { excludeMe: true });
        const serverTitle = (conv?.title || '').trim();
        const shouldRename = opts.alwaysRename === true || _isGenericTitle(serverTitle);

        GDBG.log('createGroup:titleDecision', { serverTitle, desired, shouldRename });

        // 3) rename if needed
        if (shouldRename) {
            try {
                await _apiPatch(`/dm/conversations/${cid}/title`, { title: desired });
                // Re-read to ensure we reflect whatever the server persisted
                conv = await _apiGet(`/dm/conversations/${cid}`);
                GDBG.log('createGroup:renamed', { finalTitle: conv?.title });
            } catch (e) {
                GDBG.err('createGroup:renameFailed', e);
            }
        }

        // 4) Update local meta so UI shows immediately
        try {
            const finalTitle = (conv?.title || desired || 'Group');
            const meta = {
                name: finalTitle,
                photo: conv?.photo || DEFAULT_PFP_GROUP,
                is_group: true,
                color: conv?.color || color || null,
                auto_title: _isGenericTitle(serverTitle) // was generic before we set it
            };
            state.convMeta?.set?.(cid, meta);
            // Persist + surface in the left list if needed
            state.convItems?.set?.(cid, { id: cid, is_group: true, title: finalTitle, preview: '', color: meta.color });
            scheduleSaveMeta?.();
            GDBG.log('createGroup:localMetaSet', { cid, meta });
        } catch (e) {
            GDBG.warn('createGroup:localMetaSet failed (non-fatal)', e);
        }

        return {
            id: cid,
            conversation: conv || {},
            title: conv?.title || desired,
            color: conv?.color || color || null
        };
    }

    async function renameGroupToMembers(conversationId) {
        if (!conversationId) throw new Error('renameGroupToMembers: missing conversationId');
        const conv = await _apiGet(`/dm/conversations/${conversationId}`);
        const desired = computeMemberListTitle(conv, { excludeMe: true });
        GDBG.log('renameGroupToMembers', { conversationId, desired });
        await _apiPatch(`/dm/conversations/${conversationId}/title`, { title: desired });
        try {
            const prev = state.convMeta?.get?.(conversationId) || {};
            state.convMeta?.set?.(conversationId, { ...prev, name: desired, auto_title: true });
            scheduleSaveMeta?.();
        } catch { }
        return desired;
    }

    // ---- export a tiny surface you can call from chat.js (after you strip its old creation code)
    window.MessagesApp.groups = Object.assign(window.MessagesApp.groups || {}, {
        create: createGroup,
        renameToMembers: renameGroupToMembers,
        // handy re-export
        computeMemberListTitle
    });


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
            updateAllMessageBorders
        },
        api: {
            api, getMe, fetchMsgColors, setMyMsgColor, patchMsgColors,
            setColorMap, getColorMap, syncMsgColors, chooseUniqueColorsForUsers
        }
    });
})();
