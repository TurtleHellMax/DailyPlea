(() => {
    const API = 'http://localhost:3000/api';
    const $ = (id) => document.getElementById(id);

    // ---------- state ----------
    const state = {
        convId: null, meId: 0,
        allConvs: [], filteredConvs: [],
        lastMsgId: 0, oldestMsgId: null, nextBefore: null,
        es: null, esGlobal: null, poll: null,
        uploading: false,
        pendingFiles: [],
        recording: { active: false, chunks: [], size: 0, rec: null, warnShown: false, mime: '' },

        // conv + meta
        convMeta: new Map(),
        convRowEls: new Map(),
        convUserOg: new Map(),
        userCache: new Map(),
        convItems: new Map(),

        audioPlayers: new Map(),
        msgColorsByConv: new Map(),
        convDetailById: new Map(),
        currentConvDetail: null,

        renderedMsgIds: new Set(),
        fetchingAfter: false,
        meSlug: '',
    };

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

    function saveLastDM() { try { localStorage.setItem(LASTDM_KEY, JSON.stringify({ meId: state.meId | 0, convId: state.convId | 0, at: Date.now() })) } catch { } }
    function loadLastDM() { try { return JSON.parse(localStorage.getItem(LASTDM_KEY) || 'null'); } catch { return null; } }

    function _getHideMap() { try { return JSON.parse(localStorage.getItem(HIDE_BEFORE_KEY) || '{}'); } catch { return {}; } }
    function _setHideMap(m) { try { localStorage.setItem(HIDE_BEFORE_KEY, JSON.stringify(m)); } catch { } }
    const getHideBeforeId = (cid) => (_getHideMap()[cid] | 0);
    function setHideBeforeId(cid, id) { const m = _getHideMap(); m[cid] = id | 0; _setHideMap(m); }
    function clearHideBeforeId(cid) { const m = _getHideMap(); delete m[cid]; _setHideMap(m); }
    function filterHidden(items, cid = state.convId) {
        const cut = getHideBeforeId(cid) | 0; if (!cut) return items || [];
        return (items || []).filter(m => (m.id | 0) > cut);
    }

    function joinNames(arr) { const a = (arr || []).filter(Boolean); if (!a.length) return 'Group'; if (a.length === 1) return a[0]; if (a.length === 2) return a[0] + ' & ' + a[1]; return a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1]; }
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
        const isJSON = opts.body && !(opts.body instanceof FormData);
        if (isJSON && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        const url = API + path;
        const r = await fetch(url, { credentials: 'include', method: opts.method || 'GET', headers, body: isJSON ? JSON.stringify(opts.body) : opts.body });
        const t = await r.text(); let d; try { d = t ? JSON.parse(t) : {} } catch { d = { raw: t } }
        if (!r.ok) { const e = new Error(d?.error || r.statusText); e.status = r.status; e.detail = d?.detail || t; throw e; }
        return d;
    }
    async function getMe() {
        const j = await api('/auth/me');
        state.meId = j?.user?.id || 0;
        state.meSlug = j?.user?.first_username || j?.user?.username || '';
        return state.meId;
    }

    async function fetchMsgColors(cid) { const j = await api(`/dm/conversations/${cid}/message_colors`); return j?.colors || {}; }
    const setMyMsgColor = (cid, color) => api(`/dm/conversations/${cid}/message_colors/me`, { method: 'PATCH', body: { color } });
    const patchMsgColors = (cid, colors) => api(`/dm/conversations/${cid}/message_colors`, { method: 'PATCH', body: { colors } });

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
            const color = available.length ? available.splice((Math.random() * available.length) | 0, 1)[0]
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

    // expose
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
        api: { api, getMe, fetchMsgColors, setMyMsgColor, patchMsgColors, setColorMap, getColorMap, syncMsgColors, chooseUniqueColorsForUsers }
    });
})();
