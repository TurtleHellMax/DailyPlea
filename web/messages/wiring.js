(() => {
    const { $, state, DEFAULT_PFP_DM, DEFAULT_PFP_GROUP, GROUP_COLORS } = window.MessagesApp;
    const UI = window.UIOverlays || {};
    const wireBasicChatControls = UI.wireBasicChatControls || window.wireBasicChatControls;
    const ChatMenuUI = UI.ChatMenuUI || window.ChatMenuUI;
    const MyColorOverlayUI = UI.MyColorOverlayUI || window.MyColorOverlayUI;
    const ChatSettingsUI = UI.ChatSettingsUI || window.ChatSettingsUI;
    const FriendPickerUI = UI.FriendPickerUI || window.FriendPickerUI;
    const RestyleGroupUI = UI.RestyleGroupUI || window.RestyleGroupUI;

    // ---- Compose controls
    function uploadsInFlight() {
        return state.uploading || state.pendingFiles.some(f => f.status === 'compressing');
    }
    function syncSendUI() {
        const btn = $('btn-send');
        const busy = uploadsInFlight() || state.recording.active;
        if (!btn) return;
        btn.disabled = busy;
        btn.textContent = state.uploading ? 'Sending…' : 'Send';
        btn.title = busy ? (state.uploading ? 'Uploading message…' : 'Waiting for attachments to finish…') : '';
    }
    window.MessagesApp.syncSendUI = syncSendUI;

    wireBasicChatControls({
        onFilesChosen: window.MessagesApp.attachments.handleFileInput,
        onSend: window.MessagesApp.chat.sendMessage,
        onStartRecording: window.MessagesApp.audio.startRecording,
        onStopRecording: () => window.MessagesApp.audio.stopRecording(false),
        isRecording: () => state.recording.active
    });

    // ---- People picker
    window.MessagesApp.closePicker = () => {
        const el = document.getElementById('friend-picker-overlay') || document.getElementById('overlay');
        if (el) el.style.display = 'none';
    };

    // ---- My Message Color
    const myColor = new MyColorOverlayUI({
        syncColors: () => window.MessagesApp.api.syncMsgColors(state.convId, { retry: 2 }),
        getColorMap: () => window.MessagesApp.api.getColorMap(state.convId),
        setMyColor: (hexOrNull) => window.MessagesApp.api.setMyMsgColor(state.convId, hexOrNull),
        getContext: () => ({ meId: state.meId, meName: state.meSlug || 'Me', mePhoto: '', isGroup: !!(state.currentConvDetail?.is_group) }),
        DEFAULT_PFP_DM
    });

    // ---- Chat Settings (Info, Style, Deletion, Reactions)
    const chatSettings = new ChatSettingsUI({
        GROUP_COLORS,
        DEFAULT_PFP_GROUP,
        getContext: () => {
            const det = state.currentConvDetail || {};
            const meta = state.convMeta.get(state.convId) || {};
            return { isGroup: !!det.is_group, convId: state.convId, meta, det };
        },
        onSaveBasics: async ({ title }) => {
            const cid = state.convId | 0; if (!cid) return;
            const name = (title || '').trim();
            await window.MessagesApp.api.api(`/dm/conversations/${cid}/title`, { method: 'PATCH', body: { title: name } });
            window.MessagesApp.chat.setConvMeta(cid, { name, auto_title: false });
            if (state.currentConvDetail) state.currentConvDetail.title = name;
            window.MessagesApp.renderChatMenu?.();
        },
        onSaveStyle: async ({ color, iconBlob, useDefaultIcon }) => {
            const cid = state.convId | 0; if (!cid) return;
            if (color) {
                await window.MessagesApp.api.api(`/dm/conversations/${cid}/color`, { method: 'PATCH', body: { color } });
                window.MessagesApp.chat.setConvMeta(cid, { color });
            }
            if (useDefaultIcon) {
                await window.MessagesApp.api.api(`/dm/conversations/${cid}/icon`, { method: 'DELETE' });
                window.MessagesApp.chat.setConvMeta(cid, { photo: DEFAULT_PFP_GROUP });
            } else if (iconBlob) {
                const fd = new FormData(); fd.append('icon', iconBlob, 'icon.png');
                const r = await fetch(`${window.MessagesApp.API}/dm/conversations/${cid}/icon`, { method: 'POST', credentials: 'include', body: fd });
                if (!r.ok) throw new Error(await r.text());
                const ts = Date.now();
                window.MessagesApp.chat.setConvMeta(cid, { photo: `${window.MessagesApp.API}/dm/conversations/${cid}/icon?ts=${ts}` });
            }
        },
        onSaveReactions: async ({ enabled, mode }) => {
            const cid = state.convId | 0; if (!cid) return;
            await window.MessagesApp.api.api(`/dm/conversations/${cid}/settings`, { method: 'PATCH', body: { reactable: !!enabled, reaction_mode: mode } });
            window.MessagesApp.chat.setConvMeta(cid, { reactions_enabled: !!enabled, reactions_mode: mode, reactable: !!enabled });
            if (state.currentConvDetail) {
                state.currentConvDetail.reactions_enabled = !!enabled;
                state.currentConvDetail.reactable = !!enabled;
                state.currentConvDetail.reactions_mode = mode;
            }
        },
        onSaveDeletion: async ({ enabled, windowSec }) => {
            const cid = state.convId | 0; if (!cid) return;
            await window.MessagesApp.api.api(`/dm/conversations/${cid}/settings`, { method: 'PATCH', body: { allow_delete: !!enabled, delete_window_sec: enabled ? (windowSec ?? null) : null } });
            window.MessagesApp.chat.setConvMeta(cid, {
                message_delete_enabled: !!enabled,
                allow_delete: !!enabled,
                message_delete_window_sec: enabled ? (windowSec ?? null) : null
            });
            if (state.currentConvDetail) {
                state.currentConvDetail.message_delete_enabled = !!enabled;
                state.currentConvDetail.allow_delete = !!enabled;
                state.currentConvDetail.message_delete_window_sec = enabled ? (windowSec ?? null) : null;
            }
        },
        onDeleteForMe: async () => {
            const cid = state.convId | 0; if (!cid) return;
            await window.MessagesApp.api.api(`/dm/conversations/${cid}/hide`, { method: 'POST' });
            await window.MessagesApp.chat.loadConversations({ blockingMeta: true });
            const next = state.allConvs.find(c => (c.id | 0) !== cid);
            if (next) await window.MessagesApp.chat.openConversation(next.id);
            else {
                $('msgs').innerHTML = '<div id="pad-top"></div><div id="pad-bottom"></div>';
                state.convId = 0; $('chat-title').textContent = 'Direct Message';
            }
        },
        onLeaveGroup: async () => {
            const cid = state.convId | 0; if (!cid) return;
            await window.MessagesApp.api.api(`/dm/conversations/${cid}/leave`, { method: 'POST' });
            await window.MessagesApp.chat.loadConversations({ blockingMeta: true });
            const next = state.allConvs[0]; if (next) await window.MessagesApp.chat.openConversation(next.id);
        },
        onBlockGroup: async () => {
            const cid = state.convId | 0; if (!cid) return;
            await window.MessagesApp.api.api(`/dm/conversations/${cid}/block`, { method: 'POST' });
            await window.MessagesApp.chat.loadConversations({ blockingMeta: true });
            const next = state.allConvs[0]; if (next) await window.MessagesApp.chat.openConversation(next.id);
        }
    });

    // expose for others
    window.MessagesApp.chatSettings = chatSettings;

    // ---- Tiny confirm (DM only)
    function ensureMiniConfirm() {
        let el = document.getElementById('mini-confirm');
        if (el) return el;
        el = document.createElement('div'); el.id = 'mini-confirm'; el.className = 'cs-modal'; el.style.display = 'none';
        el.innerHTML = `
      <div class="sheet">
        <h3 data-ref="title">Confirm</h3>
        <div class="muted" data-ref="body"></div>
        <div class="footer">
          <button class="btn secondary" data-act="cancel" type="button">Cancel</button>
          <button class="btn danger" data-act="ok" type="button">OK</button>
        </div>
      </div>`;
        document.body.appendChild(el);
        el.addEventListener('click', (e) => {
            if (e.target === el) return (el.style.display = 'none');
            const a = e.target.closest('[data-act]'); if (!a) return;
            if (a.dataset.act === 'cancel') el.style.display = 'none';
            if (a.dataset.act === 'ok') { const fn = el._ok; el._ok = null; el.style.display = 'none'; fn && fn(); }
        });
        return el;
    }
    function confirmDM({ title, body, okText = 'OK', onOk }) {
        const el = ensureMiniConfirm();
        el.querySelector('[data-ref="title"]').textContent = title;
        el.querySelector('[data-ref="body"]').textContent = body || '';
        el.querySelector('[data-act="ok"]').textContent = okText;
        el._ok = onOk; el.style.display = 'flex';
    }

    // ---- 3-dots menu (wires to settings + overlays)
    const chatMenu = new ChatMenuUI({
        menuEl: $('chat-menu'),
        buttonEl: $('chat-menu-btn'),
        getContext: () => ({ isGroup: !!(state.currentConvDetail?.is_group), isOwner: !!(state.currentConvDetail?.is_owner) }),
        handlers: {
            settings: () => {
                const isGroup = !!(state.currentConvDetail?.is_group);
                // Open your overlay (Info for groups, Deletion tab for DMs)
                window.MessagesApp.chatSettings.show(isGroup ? 'info' : 'deletion');
            },

            // keep the rest as-is…
            manage: () => friendPicker.open('group-edit', {
                preselectIds: (state.currentConvDetail?.members || [])
                    .filter(u => (u.id | 0) !== (state.meId | 0))
                    .map(u => u.id)
            }),
            viewMembers: () => friendPicker.open('view-members', {
                preselectIds: (state.currentConvDetail?.members || [])
                    .filter(u => (u.id | 0) !== (state.meId | 0))
                    .map(u => u.id)
            }),
            myColor: () => myColor.show(),
            toggleReactions: () => window.MessagesApp.chatSettings.show('reactions'),
            toggleDeletion: () => window.MessagesApp.chatSettings.show('deletion'),
            leave: () => window.MessagesApp.chatSettings.show('info'),
            blockGroup: () => window.MessagesApp.chatSettings.show('info'),

            deleteDm: async () => {
                if (!!(state.currentConvDetail?.is_group)) { chatSettings.show('info'); return; }
                confirmDM({
                    title: 'Delete this chat for you?',
                    body: 'This removes it from your list. The other person keeps their copy.',
                    okText: 'Delete',
                    onOk: async () => {
                        const cid = state.convId | 0; if (!cid) return;
                        await window.MessagesApp.api.api(`/dm/conversations/${cid}/hide`, { method: 'POST' });
                        await window.MessagesApp.chat.loadConversations({ blockingMeta: true });
                        const next = state.allConvs[0]; if (next) await window.MessagesApp.chat.openConversation(next.id);
                    }
                });
            },
            blockUser: async () => {
                if (!!(state.currentConvDetail?.is_group)) { chatSettings.show('info'); return; }
                confirmDM({
                    title: 'Block this user?',
                    body: 'You will no longer receive messages from them. You can unblock later in settings.',
                    okText: 'Block',
                    onOk: async () => {
                        const cid = state.convId | 0; if (!cid) return;
                        await window.MessagesApp.api.api(`/dm/conversations/${cid}/block`, { method: 'POST' });
                        await window.MessagesApp.chat.loadConversations({ blockingMeta: true });
                        const next = state.allConvs[0]; if (next) await window.MessagesApp.chat.openConversation(next.id);
                    }
                });
            }
        }
    });
    window.MessagesApp.renderChatMenu = () => { try { chatMenu.render(); } catch { } };

    // Ensure initial send button state
    try { syncSendUI(); } catch { }

})();
