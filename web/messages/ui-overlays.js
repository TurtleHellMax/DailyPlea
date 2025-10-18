// ui-overlays.js — Unifying hub / barrel for all chat overlays & rails
// Every feature panel/rail registers itself by calling UIOverlays.provide(...)
//
// Contract (keys you can register):
//   Components: FriendPickerUI, MyColorOverlayUI, ChatMenuUI, RestyleGroupUI, ChatSettingsUI
//   Installers: installMsgActionsRail(opts), installDefaultReactionPicker(), installDeleteForAll()
//   Helpers:    wrapApi(apiFn), syncConvSettings(cid, { api })
//
// This file ALSO owns the send button end-to-end (gate + events).

(function (global) {
    'use strict';

    const MA = (global.MessagesApp = global.MessagesApp || {});
    const UI = (global.UIOverlays = global.UIOverlays || {});

    // ---------- tiny DOM helpers ----------
    const $ = (sel, root) => (root || document).querySelector(sel);
    const by = (sel, root) => Array.from((root || document).querySelectorAll(sel));
    const once = (fn) => { let done = false; return (...a) => (done ? undefined : ((done = true), fn(...a))); };
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
        if (/(FriendPickerUI|MyColorOverlayUI|ChatMenuUI|RestyleGroupUI|ChatSettingsUI)$/.test(key)) return 'components';
        if (/^install[A-Z]/.test(key)) return 'installers';
        if (/Api|sync|Sync/.test(key)) return 'helpers';
        if (typeof value === 'function' && /^[A-Z]/.test(key)) return 'components';
        return 'helpers';
    }

    // Public: plugin registration
    UI.provide = function provide(key, value) {
        const bucket = classifyKey(key, value);
        if (!bucket) return;
        Registry[bucket][key] = value;
        scheduleInit();
    };

    // Public: bulk registration
    UI.use = function use(bundle = {}) {
        Object.entries(bundle).forEach(([k, v]) => UI.provide(k, v));
        return UI;
    };

    // Expose the registry for introspection (read-only)
    Object.defineProperty(UI, '__registry', { get: () => Registry });

    // ---------- Minimal style install for menus (safe if present twice) ----------
    (function installBaseStyles() {
        const SID = 'ui-overlays-base-styles';
        if (document.getElementById(SID)) return;
        const st = document.createElement('style');
        st.id = SID;
        st.textContent = `
.overlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.18);z-index:2000}
.menu{position:absolute;display:none;z-index:1500;border:1px solid var(--border,#333);background:var(--bg,#111);border-radius:.6rem;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:6px}
.menu .item{padding:.35rem .6rem;border-radius:.35rem;cursor:pointer}
.menu .item:hover{background:rgba(255,255,255,.06)}
.btn{border:1px solid var(--border,#333);background:var(--bg-2,#181818);color:inherit;border-radius:.45rem;padding:.35rem .6rem;cursor:pointer}
.btn[disabled]{cursor:not-allowed; pointer-events:none}

/* Send button: visual + interactive disable for both wrapper and inner */
#btn-send[disabled],
#btn-send.is-disabled {
  opacity: .5;
  pointer-events: none;
  cursor: not-allowed;
}
#btn-send[disabled],
#btn-send.is-disabled,
#btn-send .is-disabled {
  opacity:.5;
  pointer-events:none;
  cursor:not-allowed;
}

.pill{border:1px solid var(--border,#333);background:var(--bg-2,#181818);border-radius:999px;padding:.25rem .6rem;cursor:pointer}
.chip{border:1px solid var(--border,#333);background:var(--bg-2,#181818);border-radius:999px;padding:.25rem .6rem;cursor:pointer}
.pfp.pixel{image-rendering:pixelated}

.bubble-menu-btn,.react-btn{cursor:pointer}
.msg-actions{
  position:absolute; inset:auto 8px 8px auto;
  display:none; flex-direction:column; gap:6px; z-index:10;
}
.msg:hover .msg-actions,
.msg.menu-open .msg-actions,
.msg.rx-open .msg-actions,
.msg:focus-within .msg-actions{
  display:flex !important;
}
.msg .msg-actions:empty{ display:none !important; }
.bubble-menu{display:none;position:absolute;right:0;bottom:28px}
.msg.menu-open .bubble-menu{display:block}
.msg > .hover-pad{ pointer-events:none !important; }
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

    const State = {
        bootstrapped: false,
        chatMenuBound: false,
        settingsBound: false,
        pickerBound: false,
        railBound: false,
        deleteBound: false,
        wrappedApi: false,
        sendInstalled: false,
    };

    // Utility: get API function (possibly wrapped later)
    function getApi() {
        const api = MA.api && MA.api.api;
        if (typeof api === 'function') return api;
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
                (MA.api ||= {});
                MA.api.api = wrapped;
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
            return;
        }
        // fallback
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

    // ---------- Chat Menu ----------
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

    // ---------- Chat Settings overlay ----------
    function ensureChatSettings() {
        if (State.settingsBound) { MA.renderChatMenu?.(); return; }
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
                onSaveBasics: async ({ title }) => {
                    const cid = (MA.state?.convId) | 0;
                    const name = (title || '').trim();
                    if (!cid) return;
                    try {
                        await getApi()(`/dm/conversations/${cid}/title`, { method: 'PATCH', body: { title: name } });
                        const prev = (MA.state?.convMeta?.get?.(cid)) || {};
                        const next = { ...prev, name, auto_title: false };
                        (MA.state ||= {});
                        (MA.state.convMeta ||= new Map()).set(cid, next);
                        if (MA.state.currentConvDetail) {
                            MA.state.currentConvDetail.title = name;
                            const t = document.getElementById('chat-title');
                            if (t) t.textContent = name || t.textContent;
                        }
                        MA.chat?.setConvMeta?.(cid, { name, auto_title: false });
                        MA.renderChatMenu?.();
                    } catch (e) {
                        alert(MA.utils?.errMsg?.(e) || e?.message || 'Failed to rename group');
                    }
                },
                onSaveStyle: async ({ color, iconBlob, useDefaultIcon }) => {
                    const cid = (MA.state?.convId) | 0;
                    const fd = new FormData();
                    if (color != null) fd.append('color', color);
                    if (iconBlob) fd.append('icon', iconBlob, 'icon.png');
                    if (useDefaultIcon) fd.append('use_default_icon', '1');
                    try { await getApi()(`/dm/conversations/${cid}/appearance`, { method: 'PATCH', body: fd }); }
                    catch (e) { alert(MA.utils?.errMsg?.(e) || (e?.message || e)); }
                    MA.renderChatMenu?.();
                },
                onSaveReactions: async ({ enabled, mode }) => {
                    const cid = (MA.state?.convId) | 0;
                    const body = { reactable: !!enabled, reaction_mode: enabled ? (mode || 'both') : 'none' };
                    try { await getApi()(`/dm/conversations/${cid}/settings`, { method: 'PATCH', body }); await MA.syncConvSettings(cid); }
                    catch (e) { console.error('[ui-overlays] save reactions error', e); }
                    MA.renderChatMenu?.();
                },
                onSaveDeletion: async ({ enabled, windowSec }) => {
                    const cid = (MA.state?.convId) | 0;
                    const body = { allow_delete: !!enabled };
                    if (enabled) body.delete_window_sec = (windowSec == null ? 'null' : (windowSec | 0));
                    try { await getApi()(`/dm/conversations/${cid}/settings`, { method: 'PATCH', body }); await MA.syncConvSettings(cid); }
                    catch (e) { console.error('[ui-overlays] save deletion error', e); }
                    MA.renderChatMenu?.();
                }
            });
        }
        State.settingsBound = true;
    }

    // ---------- Ancillary overlays ----------
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

    // ---------- Rail & reactions ----------
    function ensureRail() {
        if (State.railBound) return;
        const install = Registry.installers.installMsgActionsRail;
        if (typeof install !== 'function') return;
        const useNative = !!MA.useNativeMsgRail;
        const nativeSupportsDelete = (typeof MA.nativeRailSupportsDelete === 'function') && MA.nativeRailSupportsDelete() === true;
        const api = install({ useNative, nativeSupportsDelete });
        if (api?.refreshMessageActions) MA.refreshMessageActions = api.refreshMessageActions;
        if (api?.debugMsgActions) MA.debugMsgActions = api.debugMsgActions;
        State.railBound = true;
    }

    function ensureDeleteHandler() {
        if (State.deleteBound) return;
        const install = Registry.installers.installDeleteForAll;
        if (typeof install === 'function') { install(); State.deleteBound = true; }
    }

    function ensureReactionPicker() {
        if (State.pickerBound) return;
        const install = Registry.installers.installDefaultReactionPicker;
        if (typeof MA.onReactClick !== 'function' && typeof install === 'function') { install(); State.pickerBound = true; }
    }

    // ---------- SEND CONTROLLER (authoritative) ----------
    function ensureSendController() {
        if (State.sendInstalled) return;
        State.sendInstalled = true;

        // Keep a live onSend reference (set by wireBasicChatControls)
        UI.__onSend = UI.__onSend || null;

        // Helpers that do NOT trust disabled attributes (use real state + input)
        const getTextEl = () => document.getElementById('text');
        function textValue() {
            const el = getTextEl();
            if (!el) return '';
            if ('value' in el) return el.value || '';
            if (el.isContentEditable) return (el.textContent || '').replace(/\u200B/g, '');
            return '';
        }
        const hasTypedText = () => textValue().trim().length > 0;

        function hasReadyFile() {
            const pf = Array.isArray(MA.state?.pendingFiles) ? MA.state.pendingFiles : [];
            return pf.some(f =>
                f && (
                    f.status === 'ready' || f.status === 'done' ||
                    (f.buf && f.size > 0) || (f.blob && f.blob.size > 0) || (f.file && f.file.size > 0)
                )
            );
        }

        function actualCompressingCount() {
            const pf = Array.isArray(MA.state?.pendingFiles) ? MA.state.pendingFiles : [];
            return pf.reduce((n, f) => n + (f?.status === 'compressing' ? 1 : 0), 0);
        }

        // Gate computation
        function enabledNow() {
            const uploading = ((MA.state?.uploadingCount | 0) > 0) || !!MA.state?.uploading;
            return !uploading && (hasTypedText() || hasReadyFile());
        }

        // Set disabled visuals consistently on wrapper AND an inner control (if any)
        function setDisabled(el, disabled) {
            if (!el) return;
            if ('disabled' in el) {
                if (disabled) el.setAttribute('disabled', '');
                else el.removeAttribute('disabled');
            }
            el.classList.toggle('is-disabled', !!disabled);
            el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            el.style.opacity = disabled ? '0.5' : '';
            el.style.pointerEvents = disabled ? 'none' : '';
            el.style.cursor = disabled ? 'not-allowed' : '';
        }

        function innerOf(btn) { return btn?.querySelector?.('button, input[type=submit], [role=button]') || null; }

        // Authoritative sync (exported)
        // Gate computation (keep your helpers above as-is)

        MA.syncSendUI = function syncSendUI(reason = 'manual') {
            const btn = document.getElementById('btn-send');
            const inner = innerOf(btn);

            // heal counters from chips
            const detected = actualCompressingCount();
            (MA.state ||= {});
            if ((MA.state.uploadingCount | 0) !== detected) MA.state.uploadingCount = detected;

            // 🔧 FIX: do NOT OR with previous value (that made it sticky)
            MA.state.uploading = ((MA.state.uploadingCount | 0) > 0);

            const enable = !MA.state.uploading && (hasTypedText() || hasReadyFile());

            // (optional but handy) log flips
            const prev = btn?.getAttribute('data-last-enable') === '1';
            if (prev !== enable) {
                console.log(`[send-gate] ${reason} enable=${enable} uploadingCount=${MA.state.uploadingCount} text=${hasTypedText()} readyFile=${hasReadyFile()} compressing=${detected}`);
                btn?.setAttribute?.('data-last-enable', enable ? '1' : '0');
            }

            setDisabled(btn, !enable);
            setDisabled(inner, !enable);

            // keep inner from ever being a submit
            try {
                if (inner?.tagName === 'BUTTON' && inner.type !== 'button') inner.type = 'button';
                if (inner?.tagName === 'INPUT' && inner.type === 'submit') inner.type = 'button';
            } catch { }

            return enable;
        };

        // Initial sync
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => MA.syncSendUI('dom:ready'), { once: true });
        } else {
            MA.syncSendUI('dom:immediate');
        }

        // Keep gate in sync with text changes (input/keyup + contenteditable mutations)
        const text = getTextEl();
        if (text) {
            on(text, 'input', () => MA.syncSendUI('text:input'), true);
            on(text, 'keyup', () => MA.syncSendUI('text:keyup'), true);
            if (text.isContentEditable) {
                new MutationObserver(() => MA.syncSendUI('text:mutation'))
                    .observe(text, { childList: true, subtree: true, characterData: true });
            }
        }
        // Safety net for late mounts
        document.addEventListener('input', (e) => {
            if (e.target && e.target.id === 'text') MA.syncSendUI('text:global-input');
        }, true);

        // Hook upload/attachments lifecycle to maintain MA.state.uploadingCount
        const prevInc = MA.uploadsInc;
        const prevDec = MA.uploadsDec;
        MA.uploadsInc = (n = 1) => {
            (MA.state ||= {}).uploadingCount = Math.max(0, (MA.state.uploadingCount | 0) + (n | 0));
            MA.syncSendUI('uploads:inc');
            if (typeof prevInc === 'function') { try { prevInc(n); } catch { } }
        };
        MA.uploadsDec = (n = 1) => {
            (MA.state ||= {}).uploadingCount = Math.max(0, (MA.state.uploadingCount | 0) - (n | 0));
            MA.syncSendUI('uploads:dec');
            if (typeof prevDec === 'function') { try { prevDec(n); } catch { } }
        };

        // inside ensureSendController() where you patch MA.attachments:

        const A = (MA.attachments = MA.attachments || {});
        const _addComp = A.addCompressingPlaceholder;
        const _replaceComp = A.replaceCompressingWith;
        const _refreshChips = A.refreshChips;

        // Only keep UI kicks — do NOT inc/dec here.
        // The compressor already calls uploadsInc/Dec; doubling causes leaks on errors.

        A.addCompressingPlaceholder = function (name) {
            const id = _addComp ? _addComp(name) : null;
            Promise.resolve().then(() => MA.syncSendUI?.('placeholder:add'));
            requestAnimationFrame(() => MA.syncSendUI?.('placeholder:add:raf'));
            return id;
        };

        A.replaceCompressingWith = function (tempId, obj) {
            const ret = _replaceComp ? _replaceComp(tempId, obj) : undefined;
            Promise.resolve().then(() => MA.syncSendUI?.('placeholder:replaced'));
            requestAnimationFrame(() => MA.syncSendUI?.('placeholder:replaced:raf'));
            return ret;
        };

        A.refreshChips = function (...args) {
            const out = _refreshChips ? _refreshChips(...args) : undefined;
            Promise.resolve().then(() => MA.syncSendUI?.('chips:refresh'));
            requestAnimationFrame(() => MA.syncSendUI?.('chips:refresh:raf'));
            return out;
        };

        // Document-level CLICK delegation (survives remounts; click == Enter)
        document.addEventListener('click', (e) => {
            const btn = e.target?.closest?.('#btn-send');
            if (!btn) return;

            // block native submit behavior always
            e.preventDefault();
            e.stopImmediatePropagation();

            const inner = innerOf(btn);
            try {
                if (inner?.tagName === 'BUTTON' && inner.type !== 'button') inner.type = 'button';
                if (inner?.tagName === 'INPUT' && inner.type === 'submit') inner.type = 'button';
            } catch { }

            if (!MA.syncSendUI('click:pre')) return;

            const send = UI.__onSend;
            if (typeof send === 'function') {
                const res = send();
                const kick = () => MA.syncSendUI('afterSend');
                Promise.resolve(res).then(kick, kick);
                requestAnimationFrame(kick);
            }
        }, true); // capture

        // Shield ANY native form submit that involves #btn-send (form=, Safari quirks, etc.)
        document.addEventListener('submit', (e) => {
            const s = e.submitter;
            if (s?.id === 'btn-send' || s?.closest?.('#btn-send')) {
                e.preventDefault();
                e.stopImmediatePropagation();
                MA.syncSendUI('submit:block');
            }
        }, true);

        // If Enter is pressed while focusing the button itself, don't let it submit
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target?.closest?.('#btn-send')) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        }, true);

        // Keep inner button de-submitted on node replacements
        const mo = new MutationObserver(() => {
            const btn = document.getElementById('btn-send');
            if (!btn) return;
            const inner = innerOf(btn);
            try {
                if (inner?.tagName === 'BUTTON' && inner.type !== 'button') inner.type = 'button';
                if (inner?.tagName === 'INPUT' && inner.type === 'submit') inner.type = 'button';
            } catch { }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ---------- wireBasicChatControls (no click handler here) ----------
    if (typeof UI.wireBasicChatControls !== 'function') {
        UI.wireBasicChatControls = function ({
            onFilesChosen,
            onSend,
            onStartRecording,
            onStopRecording,
            isRecording
        } = {}) {
            const get = (id) => document.getElementById(id);
            const text = get('text');
            const file = get('file');
            const btnAttach = get('btn-attach');
            const btnVoice = get('btn-voice');

            // Remember onSend for our delegated click handler
            UI.__onSend = (typeof onSend === 'function') ? onSend : null;

            const afterSend = (res) => {
                const kick = () => MA.syncSendUI?.('afterSend');
                Promise.resolve(res).then(kick, kick);
                requestAnimationFrame(kick);
            };

            // Attachments
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

            // Paste files into the text box
            if (text) {
                text.addEventListener('paste', (e) => {
                    const files = e.clipboardData?.files;
                    if (files && files.length && onFilesChosen) {
                        e.preventDefault();
                        onFilesChosen(files);
                    }
                }, true);
            }

            // Enter to send (same path as click)
            if (text) {
                text.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        const r = onSend && onSend();
                        afterSend(r);
                    }
                }, true);
            }

            // Voice press-and-hold
            if (btnVoice) {
                let active = false;
                const start = () => { if (active || (isRecording && isRecording())) return; active = true; onStartRecording && onStartRecording(); };
                const stop = () => { if (!active) return; active = false; onStopRecording && onStopRecording(); };
                btnVoice.addEventListener('mousedown', start);
                btnVoice.addEventListener('touchstart', (e) => { e.preventDefault(); start(); }, { passive: false });
                ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(ev => btnVoice.addEventListener(ev, stop));
                window.addEventListener('blur', stop);
            }

            // Final sync in case wiring changed anything
            MA.syncSendUI?.('wire:done');
        };
    }

    // ---------- Try to initialize everything available so far ----------
    function tryInit() {
        ensureApiWrapped();
        ensureSyncConvSettings();
        ensureChatMenu();
        ensureChatSettings();
        ensureAncillaryOverlays();
        ensureDeleteHandler();
        ensureRail();
        ensureReactionPicker();
        ensureSendController();   // <— owns send

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
