(() => {
    const { $, state, DEFAULT_PFP_DM, DEFAULT_PFP_GROUP, GROUP_COLORS } = window.MessagesApp;
    const { wireBasicChatControls, FriendPickerUI, ChatMenuUI, MyColorOverlayUI, RestyleGroupUI } = window.UIOverlays || window;
    const { handleFileInput } = window.MessagesApp.attachments;
    const { startRecording, stopRecording } = window.MessagesApp.audio;
    const { sendMessage, fetchFriends, startDmWith, fetchConvMeta, loadConversations, maybeAutoRenameGroup, setConvMeta } = window.MessagesApp.chat;
    const { syncMsgColors, getColorMap, setMyMsgColor } = window.MessagesApp.api;

    // Compose controls
    function uploadsInFlight() { return state.uploading || state.pendingFiles.some(f => f.status === 'compressing'); }
    function syncSendUI() {
        const btn = $('btn-send');
        const busy = uploadsInFlight() || state.recording.active;
        btn.disabled = busy;
        btn.textContent = state.uploading ? 'Sending…' : 'Send';
        btn.title = busy ? (state.uploading ? 'Uploading message…' : 'Waiting for attachments to finish…') : '';
    }
    window.MessagesApp.syncSendUI = syncSendUI;

    wireBasicChatControls({
        onFilesChosen: handleFileInput,
        onSend: sendMessage,
        onStartRecording: startRecording,
        onStopRecording: () => stopRecording(false),
        isRecording: () => state.recording.active
    });

    // People picker (DM / Group Create / Edit / View)
    const friendPicker = new FriendPickerUI({
        fetchFriends,
        onStartDm: (u) => startDmWith(u),
        onCreateGroup: async (ids) => {
            try {
                const color = GROUP_COLORS[(Math.random() * GROUP_COLORS.length) | 0].val;
                const res = await window.MessagesApp.api.api('/dm/conversations', { method: 'POST', body: { user_ids: ids, color } });
                await loadConversations({ blockingMeta: true });
                const cid = res.conversation_id || res.id;
                if (cid) { await fetchConvMeta(cid); window.MessagesApp.chat.openConversation(cid); }
            } catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
        },
        onEditGroup: async ({ add = [], remove = [] }) => {
            try {
                await window.MessagesApp.api.api(`/dm/conversations/${state.convId}/members`, { method: 'PATCH', body: { add_user_ids: add, remove_user_ids: remove } });
                await fetchConvMeta(state.convId);
                await loadConversations({ blockingMeta: true });
                maybeAutoRenameGroup();
            } catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
        },
        getConvContext: () => ({ isGroup: !!(state.currentConvDetail?.is_group), meId: state.meId }),
        usernameFor: (id) => window.MessagesApp.usernameFor(id),
        DEFAULT_PFP_DM
    });
    document.getElementById('btn-newdm')?.addEventListener('click', () => friendPicker.open('dm'));
    document.getElementById('btn-newgroup')?.addEventListener('click', () => friendPicker.open('group-create'));
    window.MessagesApp.closePicker = () => { try { friendPicker.close(); } catch { } };

    // 3-dots menu
    const chatMenu = new ChatMenuUI({
        menuEl: document.getElementById('chat-menu'),
        buttonEl: document.getElementById('chat-menu-btn'),
        getContext: () => ({ isGroup: !!(state.currentConvDetail?.is_group), isOwner: !!(state.currentConvDetail?.is_owner) }),
        handlers: {
            rename: async () => {
                const cur = state.convMeta.get(state.convId)?.name || '';
                const name = prompt('Group name:', cur); if (name == null) return;
                try {
                    await window.MessagesApp.api.api(`/dm/conversations/${state.convId}/title`, { method: 'PATCH', body: { title: name } });
                    setConvMeta(state.convId, { name, auto_title: false });
                } catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
            },
            manage: () => friendPicker.open('group-edit', {
                preselectIds: (state.currentConvDetail?.members || []).filter(u => (u.id | 0) !== (state.meId | 0)).map(u => u.id)
            }),
            viewMembers: () => friendPicker.open('view-members', {
                preselectIds: (state.currentConvDetail?.members || []).filter(u => (u.id | 0) !== (state.meId | 0)).map(u => u.id)
            }),
            restyle: () => restyle.show(),
            myColor: () => myColor.show(),
            leave: async () => {
                if (!confirm('Leave this group?')) return;
                try { await window.MessagesApp.api.api(`/dm/conversations/${state.convId}/leave`, { method: 'POST' }); await loadConversations({ blockingMeta: true }); }
                catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
            },
            deleteDm: async () => {
                if (!confirm('Delete this chat (for you)?')) return;
                try { await window.MessagesApp.api.api(`/dm/conversations/${state.convId}`, { method: 'DELETE' }); await loadConversations({ blockingMeta: true }); }
                catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
            }
        }
    });
    window.MessagesApp.renderChatMenu = () => { try { chatMenu.render(); } catch { } };

    // “My Message Color”
    const myColor = new MyColorOverlayUI({
        syncColors: () => syncMsgColors(state.convId, { retry: 2 }),
        getColorMap: () => getColorMap(state.convId),
        setMyColor: (hexOrNull) => setMyMsgColor(state.convId, hexOrNull),
        getContext: () => ({ meId: state.meId, meName: state.meSlug || 'Me', mePhoto: '', isGroup: !!(state.currentConvDetail?.is_group) }),
        DEFAULT_PFP_DM
    });

    // “Restyle Group”
    const restyle = new RestyleGroupUI({
        GROUP_COLORS,
        DEFAULT_PFP_GROUP,
        getMeta: () => {
            const meta = state.convMeta.get(state.convId) || {};
            return { isGroup: !!(state.currentConvDetail?.is_group), color: meta.color, photo: meta.photo };
        },
        onSave: async ({ color, iconBlob, useDefaultIcon }) => {
            try {
                if (color) {
                    await window.MessagesApp.api.api(`/dm/conversations/${state.convId}/color`, { method: 'PATCH', body: { color } });
                    setConvMeta(state.convId, { color });
                }
                if (useDefaultIcon) {
                    await window.MessagesApp.api.api(`/dm/conversations/${state.convId}/icon`, { method: 'DELETE' });
                    setConvMeta(state.convId, { photo: DEFAULT_PFP_GROUP });
                } else if (iconBlob) {
                    const fd = new FormData(); fd.append('icon', iconBlob, 'icon.png');
                    const r = await fetch(`${window.MessagesApp.API}/dm/conversations/${state.convId}/icon`, { method: 'POST', credentials: 'include', body: fd });
                    if (!r.ok) throw new Error(await r.text());
                    const ts = Date.now();
                    setConvMeta(state.convId, { photo: `${window.MessagesApp.API}/dm/conversations/${state.convId}/icon?ts=${ts}` });
                }
            } catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
        }
    });
})();
