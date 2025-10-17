// overlays.helpers.api.js
// Registers: wrapApi, syncConvSettings
// - wrapApi(): logs, JSON body normalization, and dedupes /dm/reactions/custom/library
// - syncConvSettings(): normalizes server shapes → MA.state.convMeta; safe across variants

(function (global) {
    'use strict';
    const UI = (global.UIOverlays = global.UIOverlays || {});
    const MA = (global.MessagesApp = global.MessagesApp || {});

    // --- tiny utils
    const toTs = (v) => {
        if (!v && v !== 0) return null;
        if (typeof v === 'number') return (v > 2e10) ? v : (v * 1000);
        const t = new Date(v).getTime();
        return Number.isFinite(t) ? t : null;
    };
    const asBoolOrNull = (v) => {
        if (v === undefined || v === null || v === 'undefined' || v === 'null') return null;
        return (v === true || v === 1 || String(v).toLowerCase() === '1' || String(v).toLowerCase() === 'true');
    };
    const asIntOrNull = (v) => (v == null || v === 'null' || v === '') ? null : (Number(v) | 0);

    // --- wrapper with logging + single-flight cache (/dm/reactions/custom/library)
    function wrapApi(originalApiFn) {
        if (typeof originalApiFn !== 'function') return originalApiFn;

        let _libCache = null;
        let _libInflight = null;
        let _libLastFailAt = 0;
        let _libBackoffMs = 0;

        // local "saved" mirror so UI can reflect state immediately
        const SAVED_LS_KEY = 'rx.saved.v1';
        function _readSaved() {
            try { return new Set((JSON.parse(localStorage.getItem(SAVED_LS_KEY) || '[]') || []).map(Number)); }
            catch { return new Set(); }
        }
        function _writeSaved(set) {
            try { localStorage.setItem(SAVED_LS_KEY, JSON.stringify([...set])); } catch { }
        }

        async function getCustomLibrary() {
            if (_libCache) return _libCache;
            if (_libInflight) return _libInflight;

            // backoff
            const now = Date.now();
            if (_libLastFailAt && (now - _libLastFailAt) < _libBackoffMs) {
                return _libCache || [];
            }

            _libInflight = (async () => {
                try {
                    const resp = await originalApiFn('/dm/reactions/custom/library', { method: 'GET' });
                    const raw = Array.isArray(resp?.items) ? resp.items : (resp?.items || []);
                    const ls = _readSaved();
                    const items = raw.map(e => {
                        const id = Number(e?.id);
                        const savedServer = !!(e?.saved ?? e?.bookmarked ?? e?.starred ?? e?.is_saved);
                        return { ...e, saved: savedServer || ls.has(id) };
                    });
                    _libCache = items;
                    _libLastFailAt = 0;
                    _libBackoffMs = 0;
                    return _libCache;
                } catch (e) {
                    _libLastFailAt = Date.now();
                    _libBackoffMs = Math.min(300000, _libBackoffMs ? _libBackoffMs * 2 : 5000);
                    return _libCache || [];
                } finally {
                    _libInflight = null;
                }
            })();

            return _libInflight;
        }

        // expose a way to force refresh from outside (e.g., after upload/delete)
        MA.refreshCustomReactionsLibrary = async () => {
            _libCache = null;
            _libLastFailAt = 0;
            _libBackoffMs = 0;
            try { await getCustomLibrary(); } catch { /* noop */ }
        };

        const wrapped = async (url, opts = {}) => {
            const method = (opts.method || 'GET').toUpperCase();
            let bodyPreview = opts.body;

            const bmMatch = String(url).match(/\/dm\/reactions\/custom\/(\d+)\/bookmark\b/);
            if (bmMatch) {
                const bodyMissing = !opts.body || (typeof opts.body === 'string' && opts.body.trim().toLowerCase() === 'null');
                if (bodyMissing && (method === 'POST' || method === 'DELETE')) {
                    // POST = save, DELETE = unsave
                    opts.body = { save: method === 'POST' };
                }
            }

            // Normalize JSON bodies (not FormData)
            if (opts.body && !(opts.body instanceof FormData)) {
                if (typeof opts.body !== 'string') {
                    try { opts.body = JSON.stringify(opts.body); } catch { /* keep as-is */ }
                }
                opts.headers = Object.assign({}, opts.headers, {
                    'Content-Type': 'application/json; charset=UTF-8',
                    'Accept': 'application/json'
                });
            }

            // Special-cased dedupe: library endpoint
            if (String(url).endsWith('/dm/reactions/custom/library') && method === 'GET') {
                const items = await getCustomLibrary();
                return { ok: true, items };
            }

            // friendly log (avoid huge spam)
            try {
                if (bodyPreview instanceof FormData) {
                    const entries = [];
                    try { for (const [k, v] of bodyPreview.entries()) entries.push([k, (v && v.name) ? `Blob(${v.type || '?'}, ${v.size || '?'})` : String(v)]); } catch { }
                    bodyPreview = entries;
                } else if (typeof bodyPreview !== 'string') {
                    bodyPreview = JSON.stringify(bodyPreview || null)?.slice(0, 400);
                }
                console.debug('[api->]', method, url, { headers: opts.headers, body: bodyPreview });
            } catch { /* ignore */ }

            try {
                const resp = await originalApiFn(url, opts);
                // if we just toggled a bookmark, mirror it locally and refresh cache
                if (bmMatch) {
                    const id = Number(bmMatch[1]);
                    let want = (method === 'POST');
                    try {
                        const bObj = (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body) || {};
                        if ('save' in bObj) want = !!bObj.save;
                    } catch { /* keep default */ }

                    const set = _readSaved();
                    if (want) set.add(id); else set.delete(id);
                    _writeSaved(set);

                    try { await MA.refreshCustomReactionsLibrary?.(); } catch { }
                }
                const logObj = (typeof resp === 'string')
                    ? { type: 'string', preview: resp.slice(0, 300) }
                    : { type: typeof resp, keys: resp && typeof resp === 'object' ? Object.keys(resp) : null };
                console.debug('[api<-]', method, url, logObj);
                return resp;
            } catch (e) {
                const info = {
                    message: e?.message,
                    name: e?.name,
                    detail: e?.detail,
                    stack: e?.stack ? String(e.stack).split('\n').slice(0, 2).join(' | ') : undefined
                };
                console.error('[api x]', method, url, info);
                throw e;
            }
        };

        // mark so the hub won't double-wrap
        wrapped.__uiOverlaysWrapped = true;
        return wrapped;
    }

    // --- settings sync (normalizes divergent server keys → convMeta + detail)
    async function syncConvSettings(cid, { api } = {}) {
        if (!cid) return;
        const call = api || (MA.api && MA.api.api) || (async () => { throw new Error('api missing'); });

        console.debug('[ui][sync settings][start]', { cid });
        const raw = await call(`/dm/conversations/${cid}/settings`, { method: 'GET' });
        // unwrap { ok, settings } variants
        const sdata = (raw && raw.settings && typeof raw.settings === 'object') ? raw.settings : (raw || {});

        const meta = {};

        // reactions
        const rxEnabledRaw = (sdata.reactable ?? sdata.reactions_enabled);
        const rxModeRaw = (sdata.reaction_mode ?? sdata.reactions_mode);
        const rxEffRaw = (sdata.reactions_effective_from ?? sdata.reactions_effective_from_ts);

        meta.reactions_enabled = asBoolOrNull(rxEnabledRaw);
        meta.reactions_mode = (rxModeRaw || 'both');
        meta.reactions_effective_from_ts = toTs(rxEffRaw);

        // deletion
        const delEnabledRaw = (sdata.allow_delete ?? sdata.message_delete_enabled);
        const delWinRaw = (sdata.delete_window_sec ?? sdata.message_delete_window_sec);
        const delEffRaw = (sdata.delete_effective_from ?? sdata.delete_effective_from_ts);

        meta.message_delete_enabled = asBoolOrNull(delEnabledRaw);
        meta.message_delete_window_sec = (meta.message_delete_enabled === true) ? asIntOrNull(delWinRaw) : null;
        meta.delete_effective_from_ts = toTs(delEffRaw);

        const s = (MA.state ||= {});
        const prev = s.convMeta?.get?.(cid) || {};
        const next = { ...prev, ...meta };

        if (MA.chat?.setConvMeta) {
            MA.chat.setConvMeta(cid, next);
        } else {
            (s.convMeta ||= new Map()).set(cid, next);
        }

        if ((s.convId | 0) === (cid | 0) && s.currentConvDetail) {
            s.currentConvDetail.reactions_enabled = meta.reactions_enabled;
            s.currentConvDetail.message_delete_enabled = meta.message_delete_enabled;
            s.currentConvDetail.message_delete_window_sec = meta.message_delete_window_sec;
            s.currentConvDetail.reactable = meta.reactions_enabled;
            s.currentConvDetail.allow_delete = meta.message_delete_enabled;
            s.currentConvDetail.delete_window_sec = meta.message_delete_window_sec;
        }

        console.debug('[ui][sync settings][ok]', { cid, next });
    }

    UI.provide('wrapApi', wrapApi);
    UI.provide('syncConvSettings', syncConvSettings);
})(typeof window !== 'undefined' ? window : globalThis);
