// ui-overlays.js — Unifying hub / barrel for all chat overlays & rails
// Drop this early on the page. Each feature panel/rail registers itself
// by calling UIOverlays.provide(...) from its own script file.
//
// Contract (keys you can register):
//   Components (classes):
//     - FriendPickerUI
//     - MyColorOverlayUI
//     - ChatMenuUI
//     - RestyleGroupUI
//     - ChatSettingsUI
//
//   Installers (functions that wire themselves and/or return APIs):
//     - installMsgActionsRail(opts)         // { useNative, nativeSupportsDelete } → { refreshMessageActions, debugMsgActions }
//     - installDefaultReactionPicker()      // installs MA.onReactClick if none present
//     - installDeleteForAll()               // sets MA.onDeleteForAll
//
//   Helpers:
//     - wrapApi(apiFn)                      // returns wrapped apiFn with logging/caching + sets MA.refreshCustomReactionsLibrary
//     - syncConvSettings(cid, { api })      // pulls /settings and normalizes → writes MA.state.convMeta & refreshes actions
//
// The hub bootstraps when DOM is ready, and also re-tries when new modules register
// (late-loading plugin scripts are supported).

(function (global) {
    'use strict';

    const MA = (global.MessagesApp = global.MessagesApp || {});
    const $ = (sel, root) => (root || document).querySelector(sel);
    const by = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const once = (fn) => { let did = false; return (...a) => (did ? undefined : ((did = true), fn(...a))); };
    const on = (el, ev, fn, opt) => el && el.addEventListener(ev, fn, opt);

    // ---------- Registry ----------
    const Registry = {
        components: Object.create(null),  // FriendPickerUI, MyColorOverlayUI, ChatMenuUI, RestyleGroupUI, ChatSettingsUI
        installers: Object.create(null),  // installMsgActionsRail, installDefaultReactionPicker, installDeleteForAll
        helpers: Object.create(null),     // wrapApi, syncConvSettings
    };

    function classifyKey(key, value) {
        if (!key) return null;
        if (key in Registry.components) return 'components';
        if (key in Registry.installers) return 'installers';
        if (key in Registry.helpers) return 'helpers';

        // heuristics for first-time keys:
        if (/(FriendPickerUI|MyColorOverlayUI|ChatMenuUI|RestyleGroupUI|ChatSettingsUI)$/.test(key)) return 'components';
        if (/^install[A-Z]/.test(key)) return 'installers';
        if (/Api|sync|Sync/.test(key)) return 'helpers';
        // default to components for classes (constructor name)
        if (typeof value === 'function' && /^[A-Z]/.test(key)) return 'components';
        return 'helpers';
    }

    // Public: plugin registration
    const UI = (global.UIOverlays = global.UIOverlays || {});
    UI.provide = function provide(key, value) {
        const bucket = classifyKey(key, value);
        if (!bucket) return;
        Registry[bucket][key] = value;
        // Attempt init after a short tick (supports late module loads)
        scheduleInit();
    };

    // Public: bulk registration
    UI.use = function use(bundle = {}) {
        Object.entries(bundle).forEach(([k, v]) => UI.provide(k, v));
        return UI;
    };

    // Expose the registry for introspection (read-only)
    Object.defineProperty(UI, '__registry', { get: () => Registry });

    // ---------- Minimal style install for menus (optional; safe if present twice) ----------
    (function installBaseStyles() {
        const SID = 'ui-overlays-base-styles';
        if (document.getElementById(SID)) return;
        const st = document.createElement('style');
        st.id = SID;
        st.textContent = `
/* basic shells the modules may rely on */
.overlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.18);z-index:2000}
.menu{position:absolute;display:none;z-index:1500;border:1px solid var(--border,#333);background:var(--bg,#111);border-radius:.6rem;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:6px}
.menu .item{padding:.35rem .6rem;border-radius:.35rem;cursor:pointer}
.menu .item:hover{background:rgba(255,255,255,.06)}
.btn{border:1px solid var(--border,#333);background:var(--bg-2,#181818);color:inherit;border-radius:.45rem;padding:.35rem .6rem;cursor:pointer}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.pill{border:1px solid var(--border,#333);background:var(--bg-2,#181818);border-radius:999px;padding:.25rem .6rem;cursor:pointer}
.chip{border:1px solid var(--border,#333);background:var(--bg-2,#181818);border-radius:999px;padding:.25rem .6rem;cursor:pointer}
.pfp.pixel{image-rendering:pixelated}
.bubble-menu-btn,.react-btn{cursor:pointer}
.msg-actions{position:absolute;inset:auto 8px 8px auto;display:flex;flex-direction:column;gap:6px;z-index:10}
.bubble-menu{display:none;position:absolute;right:0;bottom:28px}
.msg.menu-open .bubble-menu{display:block}
`;
        document.head.appendChild(st);
    })();

    // ---------- Boot / init orchestration ----------
    let _initScheduled = false;
    const scheduleInit = () => {
        if (_initScheduled) return;
        _initScheduled = true;
        setTimeout(() => { _initScheduled = false; tryInit(); }, 0);
    };

    // Guard so we don't re-create things
    const State = {
        bootstrapped: false,
        chatMenuBound: false,
        settingsBound: false,
        pickerBound: false,
        railBound: false,
        deleteBound: false,
        wrappedApi: false,
    };

    // Utility: get API function (possibly wrapped later)
    function getApi() {
        const api = MA.api && MA.api.api;
        if (typeof api === 'function') return api;
        // Lazily create a passthrough that throws (so dev notices)
        const missing = async () => { throw new Error('MessagesApp.api.api not available'); };
        return missing;
    }

    // Wrap MA.api.api if helper is provided (idempotent)
    function ensureApiWrapped() {
        if (State.wrappedApi) return;
        const wrapApi = Registry.helpers.wrapApi;
        const api = getApi();
        if (typeof wrapApi === 'function' && !api.__uiOverlaysWrapped) {
            const wrapped = wrapApi(api);
            if (wrapped && typeof wrapped === 'function') {
                wrapped.__uiOverlaysWrapped = true;
                // allow wrapper to surface helper(s)
                if (!MA.api) MA.api = {};
                MA.api.api = wrapped;
                // optional helper the wrapper may add:
                // MA.refreshCustomReactionsLibrary()
                State.wrappedApi = true;
            }
        }
    }

    // Provide syncConvSettings on MA using helper if present (or no-op fallback)
    function ensureSyncConvSettings() {
        if (typeof MA.syncConvSettings === 'function' && MA.syncConvSettings.__uiOverlays) return;
        const sync = Registry.helpers.syncConvSettings;
        if (typeof sync === 'function') {
            const fn = async (cid) => {
                const api = getApi();
                try { await sync(cid, { api }); } finally { MA.refreshMessageActions?.(); }
            };
            fn.__uiOverlays = true;
            MA.syncConvSettings = fn;
        } else {
            // fallback that does minimal normalization
            const fallback = async (cid) => {
                const api = getApi();
                try {
                    const raw = await api(`/dm/conversations/${cid}/settings`, { method: 'GET' });
                    const s = (raw && raw.settings && typeof raw.settings === 'object') ? raw.settings : (raw || {});
                    const asBoolOrNull = (v) => (v == null ? null : (v === true || v === 1 || String(v).toLowerCase() === 'true'));
                    const asIntOrNull = (v) => (v == null || v === 'null' ? null : (Number(v) | 0));
                    const toTs = (v) => { if (!v) return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };
                    const meta = {
                        reactions_enabled: asBoolOrNull(s.reactable ?? s.reactions_enabled),
                        reactions_mode: (s.reaction_mode ?? s.reactions_mode ?? 'both'),
                        reactions_effective_from_ts: toTs(s.reactions_effective_from ?? s.reactions_effective_from_ts),
                        message_delete_enabled: asBoolOrNull(s.allow_delete ?? s.message_delete_enabled),
                        message_delete_window_sec: asIntOrNull(s.delete_window_sec ?? s.message_delete_window_sec),
                        delete_effective_from_ts: toTs(s.delete_effective_from ?? s.delete_effective_from_ts),
                    };
                    const prev = (MA.state?.convMeta?.get?.(cid)) || {};
                    const next = { ...prev, ...meta };
                    (MA.state ||= {});
                    (MA.state.convMeta ||= new Map()).set(cid, next);
                } catch (e) { console.warn('[ui-overlays] syncConvSettings fallback error', e); }
            };
            fallback.__uiOverlays = true;
            MA.syncConvSettings = fallback;
        }
    }

    // Instantiate & wire Chat Menu
    function ensureChatMenu() {
        if (State.chatMenuBound) return;
        const Menu = Registry.components.ChatMenuUI;
        const menuEl = document.getElementById('chat-menu');
        const btnEl = document.getElementById('chat-menu-btn');
        if (!Menu || !menuEl || !btnEl) return;

        if (!MA._chatMenuUI) {
            MA._chatMenuUI = new Menu({
                menuEl, buttonEl: btnEl,
                getContext: () => {
                    const s = MA.state || {};
                    const det = s.currentConvDetail || {};
                    const meta = (s.convMeta && s.convMeta.get?.(s.convId)) || {};
                    return {
                        isGroup: !!det.is_group,
                        isOwner: !!det.is_owner || ((det.owner_id | 0) === (s.meId | 0)),
                        reactionsEnabled: !!(meta.reactions_enabled ?? det.reactions_enabled),
                        messageDeleteEnabled: !!(meta.message_delete_enabled ?? det.message_delete_enabled),
                    };
                },
                handlers: MA._chatMenuHandlers || {}
            });
        }

        // default handlers (host can override with MA.setChatMenuHandlers)
        MA._chatMenuHandlers = Object.assign({}, MA._chatMenuHandlers, {
            rename: () => MA.renameGroup?.(),
            manage: () => {
                const ids = (MA.state?.currentConvDetail?.members || []).map(m => m.id);
                MA.openFriendPicker?.('group-edit', { preselectIds: ids });
            },
            viewMembers: () => {
                const ids = (MA.state?.currentConvDetail?.members || []).map(m => m.id);
                MA.openFriendPicker?.('view', { preselectIds: ids });
            },
            chatSettings: async () => {
                const s = MA.state || {};
                const isGroup = !!(s.currentConvDetail?.is_group);
                const cid = (s.convId) | 0;
                await MA.syncConvSettings(cid);
                // Groups: open Info (rename + danger)
                // DMs: open Deletion (Info/Style are hidden in DMs)
                MA.chatSettingsOverlay?.show?.(isGroup ? 'info' : 'deletion');
            },
            restyle: () => MA.restyleOverlay?.show?.(),
            myColor: () => MA.myColorOverlay?.show?.(),
            leave: () => MA.leaveGroup?.(),
            blockGroup: () => MA.blockGroup?.(),
            deleteChat: async () => {
                const cid = (MA.state?.convId) | 0;
                if (!cid) return;
                if (!confirm('Delete this chat for you? This won’t remove it for others.')) return;
                try {
                    await getApi()(`/dm/conversations/${cid}/hide`, { method: 'POST' });
                    await MA.chat?.loadConversations?.();
                    const next = MA.state?.allConvs?.find?.(c => (c.id | 0) !== (cid | 0));
                    if (next) await MA.chat?.openConversation?.(next.id);
                    else {
                        const msgs = document.getElementById('msgs');
                        if (msgs) msgs.innerHTML = '<div id="pad-top"></div><div id="pad-bottom"></div>';
                        MA.state.convId = 0;
                        const t = document.getElementById('chat-title'); if (t) t.textContent = 'Direct Message';
                    }
                } catch (e) { alert(MA.utils?.errMsg?.(e) || (e?.message || e)); }
            },
            blockUser: () => MA.blockUser?.(),
        });

        MA.setChatMenuHandlers = (h) => { MA._chatMenuUI.cfg.handlers = h || {}; MA._chatMenuUI.render?.(); };
        MA.renderChatMenu = () => MA._chatMenuUI.render?.();
        MA.setChatMenuHandlers(MA._chatMenuHandlers);
        MA.renderChatMenu();
        State.chatMenuBound = true;
    }

    // Instantiate Chat Settings overlay
    function ensureChatSettings() {
        if (State.settingsBound) {
            // Allow menu to re-render if needed
            MA.renderChatMenu?.();
            return;
        }
        const Settings = Registry.components.ChatSettingsUI;
        if (!Settings) return;

        if (!MA.chatSettingsOverlay) {
            const GROUP_COLORS = MA.GROUP_COLORS || [];
            const DEFAULT_PFP_GROUP = MA.DEFAULT_PFP_GROUP || '/web/default-groupavatar.png';

            MA.chatSettingsOverlay = new Settings({
                GROUP_COLORS, DEFAULT_PFP_GROUP,
                getContext: () => {
                    const s = MA.state || {};
                    const det = s.currentConvDetail || {};
                    const meta = (s.convMeta && s.convMeta.get?.(s.convId)) || {};
                    return { isGroup: !!det.is_group, convId: s.convId | 0, meta, det };
                },
                onSaveStyle: async ({ color, iconBlob, useDefaultIcon }) => {
                    const cid = (MA.state?.convId) | 0;
                    const fd = new FormData();
                    if (color != null) fd.append('color', color);
                    if (iconBlob) fd.append('icon', iconBlob, 'icon.png');
                    if (useDefaultIcon) fd.append('use_default_icon', '1');
                    try {
                        await getApi()(`/dm/conversations/${cid}/appearance`, { method: 'PATCH', body: fd });
                    } catch (e) { alert(MA.utils?.errMsg?.(e) || (e?.message || e)); }
                    MA.renderChatMenu?.();
                },
                onSaveReactions: async ({ enabled, mode }) => {
                    const cid = (MA.state?.convId) | 0;
                    const body = { reactable: !!enabled, reaction_mode: enabled ? (mode || 'both') : 'none' };
                    try {
                        await getApi()(`/dm/conversations/${cid}/settings`, { method: 'PATCH', body });
                        await MA.syncConvSettings(cid);
                    } catch (e) { console.error('[ui-overlays] save reactions error', e); }
                    MA.renderChatMenu?.();
                },
                onSaveDeletion: async ({ enabled, windowSec }) => {
                    const cid = (MA.state?.convId) | 0;
                    const body = { allow_delete: !!enabled };
                    if (enabled) body.delete_window_sec = (windowSec == null ? 'null' : (windowSec | 0));
                    try {
                        await getApi()(`/dm/conversations/${cid}/settings`, { method: 'PATCH', body });
                        await MA.syncConvSettings(cid);
                    } catch (e) { console.error('[ui-overlays] save deletion error', e); }
                    MA.renderChatMenu?.();
                }
            });
        }
        State.settingsBound = true;
    }

    // Instantiate ancillary overlays (Friend picker, Restyle, My Color)
    function ensureAncillaryOverlays() {
        // Friend Picker
        const Picker = Registry.components.FriendPickerUI;
        if (Picker && !MA._friendPicker) {
            MA._friendPicker = new Picker({
                fetchFriends: MA.chat?.fetchFriends || (async () => []),
                onStartDm: (u) => MA.chat?.startDmWith?.(u),
                onCreateGroup: (ids) => MA.createGroup?.(ids),
                onEditGroup: (delta) => MA.editGroup?.(delta),
                getConvContext: () => {
                    const s = MA.state || {};
                    return { isGroup: !!(s.currentConvDetail?.is_group), meId: s.meId | 0 };
                },
                usernameFor: (id) => (MA.usernameFor?.(id) || `user-${id}`),
                DEFAULT_PFP_DM: MA.DEFAULT_PFP_DM || '/web/default-avatar.png',
            });

            MA.openFriendPicker = (mode = 'dm', opts = {}) => MA._friendPicker.open(mode, opts);
            MA.closePicker = () => MA._friendPicker.close();
        }

        // Restyle Group
        const Restyle = Registry.components.RestyleGroupUI;
        if (Restyle && !MA.restyleOverlay) {
            MA.restyleOverlay = new Restyle({
                GROUP_COLORS: MA.GROUP_COLORS || [],
                DEFAULT_PFP_GROUP: MA.DEFAULT_PFP_GROUP || '/web/default-groupavatar.png',
                getMeta: () => {
                    const s = MA.state || {};
                    const meta = (s.convMeta && s.convMeta.get?.(s.convId)) || {};
                    const det = s.currentConvDetail || {};
                    return {
                        isGroup: !!det.is_group,
                        color: meta.color || det.color || '#ffffff',
                        photo: meta.photo || det.photo || MA.DEFAULT_PFP_GROUP,
                    };
                },
                onSave: async (payload) => {
                    const cid = (MA.state?.convId) | 0;
                    const fd = new FormData();
                    if (payload.color != null) fd.append('color', payload.color);
                    if (payload.iconBlob) fd.append('icon', payload.iconBlob, 'icon.png');
                    if (payload.useDefaultIcon) fd.append('use_default_icon', '1');
                    try {
                        await getApi()(`/dm/conversations/${cid}/appearance`, { method: 'PATCH', body: fd });
                        await MA.syncConvSettings?.(cid);
                    } catch (e) { alert(MA.utils?.errMsg?.(e) || (e?.message || e)); }
                }
            });
        }

        // My Message Color
        const MyColor = Registry.components.MyColorOverlayUI;
        if (MyColor && !MA.myColorOverlay) {
            MA.myColorOverlay = new MyColor({
                syncColors: () => MA.chat?.syncMsgColors?.(MA.state?.convId, { retry: 1 }),
                getColorMap: () => (MA.getColorMap?.(MA.state?.convId) || MA.state?.msgColorsByConv?.get?.(MA.state?.convId) || {}),
                setMyColor: async (hexOrNull) => {
                    const cid = (MA.state?.convId) | 0;
                    try {
                        await getApi()(`/dm/conversations/${cid}/mycolor`, { method: 'PATCH', body: { color: (hexOrNull || 'null') } });
                        await MA.chat?.syncMsgColors?.(cid, { retry: 1 });
                        MA.updateAllMessageBorders?.();
                    } catch (e) { alert(MA.utils?.errMsg?.(e) || (e?.message || e)); }
                },
                getContext: () => {
                    const s = MA.state || {};
                    const det = s.currentConvDetail || {};
                    const me = s.meId | 0;
                    return { meId: me, meName: '@me', mePhoto: s.mePhoto || MA.DEFAULT_PFP_DM, isGroup: !!det.is_group };
                },
                DEFAULT_PFP_DM: MA.DEFAULT_PFP_DM || '/web/default-avatar.png',
            });
        }
    }

    // Rail installer (fallback actions rail)
    function ensureRail() {
        if (State.railBound) return;
        const install = Registry.installers.installMsgActionsRail;
        if (typeof install !== 'function') return;

        const useNative = !!MA.useNativeMsgRail;
        const nativeSupportsDelete = (typeof MA.nativeRailSupportsDelete === 'function') && MA.nativeRailSupportsDelete() === true;

        const api = install({ useNative, nativeSupportsDelete });
        if (api && typeof api.refreshMessageActions === 'function') {
            MA.refreshMessageActions = api.refreshMessageActions;
        }
        if (api && typeof api.debugMsgActions === 'function') {
            MA.debugMsgActions = api.debugMsgActions;
        }
        State.railBound = true;
    }

    // Delete-for-all (endpoint cycling + tombstone)
    function ensureDeleteHandler() {
        if (State.deleteBound) return;
        const install = Registry.installers.installDeleteForAll;
        if (typeof install === 'function') {
            install(); // should define MA.onDeleteForAll
            State.deleteBound = true;
        }
    }

    // Default reaction picker (only if none provided by host)
    function ensureReactionPicker() {
        if (State.pickerBound) return;
        const install = Registry.installers.installDefaultReactionPicker;
        if (typeof MA.onReactClick !== 'function' && typeof install === 'function') {
            install(); // sets MA.onReactClick
            State.pickerBound = true;
        }
    }

    // Try to initialize everything available so far
    function tryInit() {
        ensureApiWrapped();
        ensureSyncConvSettings();
        ensureChatMenu();
        ensureChatSettings();
        ensureAncillaryOverlays();
        ensureDeleteHandler();
        ensureRail();
        ensureReactionPicker();

        State.bootstrapped = true;
    }

    // Re-render chat menu whenever we think state/meta changed
    MA.renderChatMenu = MA.renderChatMenu || (() => { });

    // Expose a small ready helper for host apps (optional)
    UI.ready = new Promise((resolve) => {
        const done = once(resolve);
        const check = () => {
            if (State.bootstrapped) return done();
            setTimeout(check, 10);
        };
        scheduleInit();
        check();
    });

    // Kick things off when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scheduleInit, { once: true });
    } else {
        scheduleInit();
    }

})(typeof window !== 'undefined' ? window : globalThis);

(function (global) {
    const UI = (global.UIOverlays = global.UIOverlays || {});
    if (typeof UI.wireBasicChatControls === 'function') return;

    UI.wireBasicChatControls = function ({
        onFilesChosen,
        onSend,
        onStartRecording,
        onStopRecording,
        isRecording
    } = {}) {
        const $ = (id) => document.getElementById(id);
        const text = $('text');
        const file = $('file');
        const btnSend = $('btn-send');
        const btnAttach = $('btn-attach');
        const btnVoice = $('btn-voice');

        if (btnAttach && file) {
            btnAttach.addEventListener('click', () => file.click());
            file.addEventListener('change', (e) => {
                try { onFilesChosen && onFilesChosen(e.target.files); }
                finally { try { file.value = ''; } catch { } }
            });
            document.addEventListener('dragover', (ev) => {
                ev.preventDefault();
                if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
            });
            document.addEventListener('drop', (ev) => {
                if (!onFilesChosen) return;
                const files = ev.dataTransfer && ev.dataTransfer.files;
                if (!files || !files.length) return;
                ev.preventDefault();
                onFilesChosen(files);
            });
        }

        if (btnSend) btnSend.addEventListener('click', () => onSend && onSend());

        if (text) {
            text.addEventListener('paste', (e) => {
                const files = e.clipboardData?.files;
                if (files && files.length && onFilesChosen) {
                    e.preventDefault();
                    onFilesChosen(files);
                }
            });
            text.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend && onSend(); }
            });
        }

        if (btnVoice) {
            let active = false;
            const start = () => { if (active || (isRecording && isRecording())) return; active = true; onStartRecording && onStartRecording(); };
            const stop = () => { if (!active) return; active = false; onStopRecording && onStopRecording(); };
            btnVoice.addEventListener('mousedown', start);
            btnVoice.addEventListener('touchstart', (e) => { e.preventDefault(); start(); }, { passive: false });
            ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(ev => btnVoice.addEventListener(ev, stop));
            window.addEventListener('blur', stop);
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);
