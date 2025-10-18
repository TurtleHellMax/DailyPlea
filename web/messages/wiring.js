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
            chatSettings: async () => {
                const cid = (window.MessagesApp.state?.convId) | 0;
                if (cid) { await window.MessagesApp.syncConvSettings?.(cid); }
                window.MessagesApp.chatSettingsOverlay?.show?.(
                    window.MessagesApp.state?.currentConvDetail?.is_group ? 'info' : 'deletion'
                );
            },
            // keep whatever else you still want:
            manage: () => friendPicker.open('group-edit', {
                preselectIds: (state.currentConvDetail?.members || [])
                    .filter(u => (u.id | 0) !== (state.meId | 0)).map(u => u.id)
            }),
            viewMembers: () => friendPicker.open('view-members', {
                preselectIds: (state.currentConvDetail?.members || [])
                    .filter(u => (u.id | 0) !== (state.meId | 0)).map(u => u.id)
            }),
            myColor: () => myColor.show(),
            leave: () => chatSettings.show('info'),
            deleteDm: async () => { /* unchanged */ },
            blockUser: async () => { /* unchanged */ },
        }
    });
    window.MessagesApp.renderChatMenu = () => { try { chatMenu.render(); } catch { } };
    window.MessagesApp.renderChatMenu(); // force re-render so the new handler is bound

    // Ensure initial send button state
    try { syncSendUI(); } catch { }

})();
