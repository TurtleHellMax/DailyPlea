(() => {
    const { API, $, state, DEFAULT_PFP_DM, DEFAULT_PFP_GROUP, GROUP_COLORS } = window.MessagesApp;
    const { esc, fmt, afterPaint, nearBottom, scrollToBottom,
        computeDefaultGroupTitle, pickName, pickPhoto, pickUsername,
        saveLastDM, loadLastDM, filterHidden, updateAllMessageBorders,
        scheduleSaveMeta } = window.MessagesApp.utils;
    const { api, getMe, syncMsgColors, getColorMap } = window.MessagesApp.api;
    const { initAudioPlayer, setPlayerTotal, unregisterPlayersIn } = window.MessagesApp.audio;
    const { renderAttachmentInline } = window.MessagesApp.attachments;

    // Helpers used across
    function isGroupChat() { return !!(state.currentConvDetail?.is_group); }
    function usernameFor(userId) {
        const det = state.currentConvDetail || {};
        const m = (det.members || []).find(u => (u.id | 0) === (userId | 0));
        const u = m || {}; return pickName(u) || 'user';
    }

    // make this name visible to overlays wiring
    window.MessagesApp.usernameFor = usernameFor;

    function setImgSafe(img, src, fallback = DEFAULT_PFP_DM) {
        if (!img) return;
        const want = src || fallback;
        if (img.dataset.srcApplied === want) return;
        img.onerror = () => { img.src = fallback; img.dataset.srcApplied = fallback; };
        img.src = want; img.dataset.srcApplied = want;
    }

    async function fetchConvMeta(id) {
        const prev = state.convMeta.get(id);
        try {
            const j = await api(`/dm/conversations/${id}`);
            let meta = { name: 'Direct Message', photo: DEFAULT_PFP_DM, is_group: !!j.is_group, color: (j.color || null) };
            if (j.is_group) {
                const members = j.members || [];
                const autoDefault = computeDefaultGroupTitle(members);
                const serverTitle = (j.title || '').trim();
                const hasCustom = !!(serverTitle && serverTitle !== autoDefault);
                meta.name = hasCustom ? serverTitle : autoDefault;
                meta.photo = j.photo || j.avatar || DEFAULT_PFP_GROUP;
                meta.color = j.color || meta.color || '#ffffff';
                meta.auto_title = !hasCustom;
            } else {
                const other = j.other || (Array.isArray(j.members) ? j.members.find(u => (u.id | 0) !== (state.meId | 0)) : null);
                meta.name = pickName(other) || meta.name;
                meta.photo = pickPhoto(other) || DEFAULT_PFP_DM;
            }
            const detail = { id: j.id, is_group: !!j.is_group, title: j.title || null, owner_id: j.owner_id || null, is_owner: !!j.is_owner, members: j.members || [] };
            state.convDetailById.set(id, detail);
            if ((state.convId | 0) === (id | 0)) state.currentConvDetail = detail;

            const best = { ...(prev || {}), ...meta };
            state.convMeta.set(id, best);
            if ((state.convId | 0) === (id | 0)) updateTopBar(best);
            return best;
        } catch {
            if (prev) return prev;
            const fb = { name: 'Direct Message', photo: DEFAULT_PFP_DM, is_group: false };
            state.convMeta.set(id, fb);
            return fb;
        }
    }
    function setConvMeta(id, meta) {
        const prev = state.convMeta.get(id) || {};
        const next = { ...prev, ...meta };
        state.convMeta.set(id, next);
        updateEverywhere(id);
        scheduleSaveMeta();
    }

    function updateTopBar(meta) {
        if (!meta) return;
        $('chat-title').textContent = meta.name || 'Direct Message';
        const pfp = $('chat-pfp');
        setImgSafe(pfp, meta.photo, meta?.is_group ? DEFAULT_PFP_GROUP : DEFAULT_PFP_DM);
        if (meta.is_group) {
            const gc = meta.color || '#ffffff';
            pfp.style.borderColor = gc; pfp.style.setProperty('--gc', gc);
            const isDefault = (meta.photo === DEFAULT_PFP_GROUP);
            pfp.classList.toggle('tinted-default', isDefault);
            pfp.classList.toggle('pixel', isDefault);
            pfp.style.background = isDefault ? gc : '#000';
        } else {
            const isDefault = (meta.photo === DEFAULT_PFP_DM);
            pfp.style.borderColor = 'var(--border)';
            pfp.classList.remove('tinted-default');
            pfp.classList.toggle('pixel', isDefault);
            pfp.style.background = '#000';
        }
        // Let wiring refresh the 3-dots menu if it's ready
        try { window.MessagesApp.renderChatMenu?.(); } catch { }
    }

    function setConvRowContent(row, meta, preview) {
        const photo = meta?.photo || (meta?.is_group ? DEFAULT_PFP_GROUP : DEFAULT_PFP_DM);
        const border = meta?.is_group ? (meta?.color || '#fff') : '#fff';
        const isDefault = (photo === DEFAULT_PFP_GROUP) || (photo === DEFAULT_PFP_DM);
        row.innerHTML = `
      <img class="avatar ${photo === DEFAULT_PFP_GROUP ? 'tinted-default' : ''} ${isDefault ? 'pixel' : ''}"
           src="${photo}" alt=""
           style="border-color:${border}; background:${photo === DEFAULT_PFP_GROUP ? border : '#000'}">
      <div>
        <div class="name">${esc(meta?.name || 'Direct Message')}</div>
        <div class="preview">${esc(preview || '…')}</div>
      </div>`;
    }

    function applySelectedHighlight() {
        document.querySelectorAll('.conv.active').forEach(el => el.classList.remove('active'));
        const el = state.convRowEls.get(state.convId);
        if (el) el.classList.add('active');
    }

    function extractOgFromConvDetail(j) {
        const direct = j?.other_username || j?.other?.first_username || j?.other?.username ||
            j?.with?.first_username || j?.with?.username || null;
        if (direct) return direct;
        const arr = j?.members || j?.participants || j?.users || j?.people || [];
        if (Array.isArray(arr) && arr.length) {
            const other = arr.find(p => ((p?.id ?? p?.user?.id) | 0) !== (state.meId | 0)) || arr[0];
            const u = other?.user || other || {};
            return pickUsername(u) || null;
        }
        return null;
    }

    function updateEverywhere(id) {
        const meta = state.convMeta.get(id); if (!meta) return;
        const row = state.convRowEls.get(id);
        if (row) setConvRowContent(row, meta, row.querySelector('.preview')?.textContent || '');
        if (state.convId === id) updateTopBar(meta);
    }

    function renderConvs(list) {
        const wrap = $('convs'); wrap.innerHTML = ''; state.convRowEls.clear();
        list.forEach(it => {
            const row = document.createElement('div'); row.className = 'conv'; row.dataset.id = it.id;
            const defaultMeta = { name: (it.is_group ? (it.title || 'Group') : (it.title || 'Direct Message')), photo: it.is_group ? DEFAULT_PFP_GROUP : DEFAULT_PFP_DM, is_group: !!it.is_group, color: it.color || null };
            const meta = state.convMeta.get(it.id) || defaultMeta;
            row.onclick = () => openConversation(it.id, meta?.name || defaultMeta.name);
            const hasCut = !!window.MessagesApp.utils.getHideBeforeId(it.id);
            const preview = hasCut ? '' : (it.preview || '');
            setConvRowContent(row, meta, preview);
            state.convRowEls.set(it.id, row);
            wrap.append(row);
            if (!state.convMeta.has(it.id)) state.convMeta.set(it.id, defaultMeta);
            if (!state.convMeta.has(it.id)) fetchConvMeta(it.id).catch(() => { });
        });
        applySelectedHighlight();
    }
    function applyConvFilter() {
        const q = $('conv-q').value.trim().toLowerCase();
        state.filteredConvs = !q ? [...state.allConvs]
            : state.allConvs.filter(c => {
                const name = (state.convMeta.get(c.id)?.name || c.title || 'Direct Message').toLowerCase();
                return name.includes(q) || (c.preview || '').toLowerCase().includes(q);
            });
        renderConvs(state.filteredConvs);
    }
    $('conv-q').addEventListener('input', applyConvFilter);

    async function loadConversations({ blockingMeta = false } = {}) {
        const j = await api('/dm/conversations');
        state.allConvs = j.items || [];
        state.allConvs.forEach(it => state.convItems.set(it.id, it));

        for (const it of state.allConvs) {
            if (!state.convMeta.has(it.id)) {
                let meta = {
                    name: it.is_group ? (it.title || 'Group') : 'Direct Message',
                    photo: it.is_group ? DEFAULT_PFP_GROUP : DEFAULT_PFP_DM,
                    is_group: !!it.is_group, color: it.color || null
                };
                if (!it.is_group) {
                    let og = state.convUserOg.get(it.id) || extractOgFromConvDetail(it);
                    if (og) {
                        state.convUserOg.set(it.id, og);
                        const cached = state.userCache.get(og);
                        meta.name = pickName(cached?.raw || cached) || og;
                        if (cached?.photo) meta.photo = cached.photo;
                        scheduleSaveMeta();
                    }
                }
                state.convMeta.set(it.id, meta);
            }
        }
        scheduleSaveMeta();

        if (blockingMeta) {
            await Promise.allSettled(state.allConvs.map(it => fetchConvMeta(it.id)));
        } else {
            state.allConvs.forEach(it => { if (!state.convMeta.has(it.id)) fetchConvMeta(it.id).catch(() => { }); });
        }
        renderConvs(state.allConvs);
    }

    // Message row bubble menu (downloads)
    function closeAllBubbleMenus() { document.querySelectorAll('.bubble-menu').forEach(el => el.style.display = 'none'); }
    function attachBubbleMenu(root, message) {
        const atts = (message.attachments || []); if (!atts.length) return;
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'bubble-menu-btn'; btn.textContent = '⋮';
        const menu = document.createElement('div'); menu.className = 'bubble-menu';
        menu.innerHTML = atts.map(a => {
            const href = `${API}/dm/attachments/${a.id}/download`;
            const filename = esc(a.filename || 'attachment');
            return `<div class="item"><a href="${href}" download="${filename}">Download ${filename}</a></div>`;
        }).join('');
        btn.addEventListener('click', e => { e.stopPropagation(); const open = menu.style.display === 'block'; closeAllBubbleMenus(); menu.style.display = open ? 'none' : 'block'; });
        root.append(btn, menu);
    }

    // Rendering a message
    function renderMessage(m, showFrom = false) {
        const isSystem = (m.kind === 'system');
        const wrap = document.createElement('div');
        wrap.className = (isSystem ? 'msg sysmsg' : ('msg' + (m.sender_id === state.meId ? ' me' : '')));
        if (!isSystem) wrap.dataset.senderId = m.sender_id || '';

        if (!isSystem && isGroupChat() && showFrom) {
            const label = document.createElement('div'); label.className = 'from'; label.textContent = usernameFor(m.sender_id); wrap.appendChild(label);
        }

        if (m.text) wrap.insertAdjacentHTML('beforeend', '<div>' + esc(m.text) + '</div>');
        if (!isSystem) {
            (m.attachments || []).forEach(a => {
                const url = `${API}/dm/attachments/${a.id}/download?inline=1`;
                if ((a.mime_type || '').startsWith('image/')) wrap.insertAdjacentHTML('beforeend', `<img class="att" src="${url}">`);
                else if ((a.mime_type || '').startsWith('video/')) wrap.insertAdjacentHTML('beforeend', `<video class="att" src="${url}" controls></video>`);
                else if ((a.mime_type || '').startsWith('audio/')) {
                    wrap.insertAdjacentHTML('beforeend', `
            <div class="audp" data-att-id="${a.id}">
              <button class="audp-btn" type="button" aria-label="Play">▶</button>
              <div class="audp-track"><div class="audp-fill"></div></div>
              <div class="audp-time"><span class="cur">0:00</span> / <span class="tot">0:00</span></div>
              <audio class="aud-src" preload="metadata" src="${url}"></audio>
            </div>`);
                    const playerRoot = wrap.lastElementChild;
                    queueMicrotask(() => {
                        initAudioPlayer(a.id, url, playerRoot);
                        if (Number.isFinite(a.duration_ms) && a.duration_ms > 0) setPlayerTotal(a.id, a.duration_ms);
                    });
                } else {
                    renderAttachmentInline(wrap, a);
                }
            });

            wrap.insertAdjacentHTML('beforeend', `<div class="meta">${m.created_at ? fmt(m.created_at) : ''}</div>`);
            const col = (getColorMap(state.convId) || {})[m.sender_id] || null;
            if (col) wrap.style.setProperty('--mbc', col);
        }

        wrap.querySelectorAll('img').forEach(img => img.addEventListener('load', () => { if (nearBottom(200)) scrollToBottom(); }, { once: true }));
        wrap.querySelectorAll('video').forEach(v => v.addEventListener('loadedmetadata', () => { if (nearBottom(200)) scrollToBottom(); }, { once: true }));
        if (!isSystem) attachBubbleMenu(wrap, m);
        return wrap;
    }

    // revoke object/audio URLs in subtree (cleanup)
    function revokeObjectURLsIn(root) { if (!root) return; root.querySelectorAll('[data-objurl]').forEach(el => { const u = el.dataset.objurl; if (u) { try { URL.revokeObjectURL(u); } catch { } } delete el.dataset.objurl; }); }
    function revokeAudioURLsIn(root) { if (!root) return; root.querySelectorAll('audio').forEach(a => { const u = a.dataset.objurl; if (u) { try { URL.revokeObjectURL(u); } catch { } delete a.dataset.objurl; } }); }

    // Virtualization
    const MAX_DOM = 140, GAP = 6; let bottomPadPx = 0, removedBottom = [];
    const setBottomPad = px => { bottomPadPx = Math.max(0, px | 0); $('pad-bottom').style.height = bottomPadPx + 'px'; };
    function maybeTrimBottom() {
        const box = $('msgs'); if (nearBottom(200)) return;
        while (true) {
            const last = $('pad-bottom').previousElementSibling; if (!last || !last.classList.contains('msg')) break;
            const count = box.querySelectorAll('.msg').length; if (count <= MAX_DOM) break;
            const h = last.offsetHeight + GAP; removedBottom.push({ el: last, h });

            last.querySelectorAll('audio').forEach(a => { const u = a.dataset.objurl; if (u) { try { URL.revokeObjectURL(u); } catch { } delete a.dataset.objurl; } });
            unregisterPlayersIn(last);

            last.remove(); setBottomPad(bottomPadPx + h);
        }
    }
    function maybeRestoreBottom(chunk = 24) {
        if (!removedBottom.length) return;
        const box = $('msgs'); const dist = (box.scrollHeight - box.clientHeight - box.scrollTop); if (dist > 1200) return;
        let n = 0; while (removedBottom.length && n < chunk) { const { el, h } = removedBottom.pop(); $('pad-bottom').before(el); setBottomPad(bottomPadPx - h); n++; }
    }
    const jumpBtn = (() => {
        const el = $('jump'); function sync() { if (nearBottom(120)) { el.classList.remove('show'); el.style.display = 'none'; } else { el.style.display = ''; el.classList.add('show'); } }
        el.addEventListener('click', () => { while (removedBottom.length) { const { el: n, h } = removedBottom.pop(); $('pad-bottom').before(n); setBottomPad(bottomPadPx - h); } scrollToBottom(); sync(); });
        return { sync };
    })();

    function appendMessagesAscending(items) {
        items = (items || []).filter(m => !state.renderedMsgIds.has(m.id)); if (!items.length) return;
        const cut = window.MessagesApp.utils.getHideBeforeId(state.convId); if (cut && items.some(m => (m.id | 0) > cut)) window.MessagesApp.utils.clearHideBeforeId(state.convId);

        const anchor = $('pad-bottom');
        items.forEach(m => {
            state.renderedMsgIds.add(m.id);
            let prev = anchor.previousElementSibling;
            while (prev && !prev.classList.contains('msg')) prev = prev.previousElementSibling;
            const prevSender = (prev && !prev.classList.contains('sysmsg')) ? (+prev.dataset.senderId || null) : null;
            const showFrom = isGroupChat() && prevSender !== (m.sender_id | 0);
            const el = renderMessage(m, showFrom); anchor.before(el);
            state.oldestMsgId = state.oldestMsgId === null ? m.id : Math.min(state.oldestMsgId, m.id);
            state.lastMsgId = Math.max(state.lastMsgId, m.id);
        });
        updateAllMessageBorders(); maybeTrimBottom();
    }
    function prependOlderAscending(items) {
        items = (items || []).filter(m => !state.renderedMsgIds.has(m.id)); if (!items.length) return;
        const box = $('msgs'); const prevTop = box.scrollTop, prevH = box.scrollHeight; const frag = document.createDocumentFragment();
        let prevSenderInThisBlock = null;
        items.forEach(m => {
            state.renderedMsgIds.add(m.id);
            const showFrom = isGroupChat() && prevSenderInThisBlock !== (m.sender_id | 0);
            const el = renderMessage(m, showFrom); frag.append(el); prevSenderInThisBlock = m.sender_id | 0;
            state.oldestMsgId = state.oldestMsgId === null ? m.id : Math.min(state.oldestMsgId, m.id);
            state.lastMsgId = Math.max(state.lastMsgId, m.id);
        });
        const afterTop = $('pad-top').nextSibling || $('pad-bottom'); box.insertBefore(frag, afterTop);

        const newLastInserted = afterTop.previousElementSibling; const oldFirst = afterTop;
        if (oldFirst && newLastInserted &&
            oldFirst.classList.contains('msg') && !oldFirst.classList.contains('sysmsg') &&
            newLastInserted.classList.contains('msg') && !newLastInserted.classList.contains('sysmsg')) {
            const same = (+oldFirst.dataset.senderId || 0) === (+newLastInserted.dataset.senderId || 0);
            const fromEl = oldFirst.querySelector('.from'); if (same && fromEl) fromEl.remove();
            if (!same && isGroupChat() && !fromEl) {
                const label = document.createElement('div'); label.className = 'from'; label.textContent = usernameFor(+oldFirst.dataset.senderId || 0);
                oldFirst.insertBefore(label, oldFirst.firstChild);
            }
        }
        box.scrollTop = prevTop + (box.scrollHeight - prevH);
        maybeTrimBottom();
    }

    // open/paging/realtime
    async function openConversation(id) {
        if (state.es) { try { state.es.close(); } catch { } state.es = null; }
        if (state.poll) { clearInterval(state.poll); state.poll = null; }

        state.convId = id; saveLastDM();
        state.currentConvDetail = state.convDetailById.get(id) || null;
        applySelectedHighlight();

        if (!state.convMeta.has(id)) {
            const seed = state.convItems.get(id) || {};
            state.convMeta.set(id, { name: seed.title || 'Direct Message', photo: seed.is_group ? DEFAULT_PFP_GROUP : DEFAULT_PFP_DM, is_group: !!seed.is_group, color: seed.color || null });
        }
        try { await fetchConvMeta(id); } catch { }

        revokeAudioURLsIn($('msgs')); revokeObjectURLsIn($('msgs'));
        $('msgs').innerHTML = '<div id="pad-top"></div><div id="pad-bottom"></div>';
        state.audioPlayers.clear();
        state.renderedMsgIds.clear();
        setBottomPad(0); removedBottom = [];
        state.lastMsgId = 0; state.oldestMsgId = null; state.nextBefore = null;

        const j = await api(`/dm/conversations/${id}/messages?limit=30`);
        appendMessagesAscending(filterHidden(j.items, id));
        state.nextBefore = j.next_before;

        try { await (document.fonts && document.fonts.ready); } catch { }
        await afterPaint(); await afterPaint(); scrollToBottom();

        jumpBtn.sync(); openStream(id); startCatchup();

        await syncMsgColors(id, { retry: 3 });
        updateAllMessageBorders();
    }

    $('msgs').addEventListener('scroll', async () => {
        jumpBtn.sync(); maybeRestoreBottom();
        const box = $('msgs');
        if (box.scrollTop <= 20 && state.nextBefore) {
            const j = await api(`/dm/conversations/${state.convId}/messages?before=${state.nextBefore}&limit=20`);
            prependOlderAscending(filterHidden(j.items));
            state.nextBefore = j.next_before;
        }
    });

    function openStream(id) {
        const es = new EventSource(`${API}/dm/conversations/${id}/stream`, { withCredentials: true });
        state.es = es; es.addEventListener('new', async () => { await fetchAfter(state.lastMsgId); });
    }
    function openGlobalStream() {
        if (state.esGlobal) { try { state.esGlobal.close(); } catch { } }
        const es = new EventSource(`${API}/dm/stream`, { withCredentials: true });
        state.esGlobal = es;
        let reloadTimer = null;
        const scheduleConvsReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { loadConversations().catch(() => { }); }, 200); };

        es.addEventListener('conv_new', e => {
            try { const d = JSON.parse(e.data || '{}'); const cid = d.conversation_id || d.id; if (cid) { state.msgColorsByConv.delete(cid); fetchConvMeta(cid).catch(() => { }); } } catch { }
            scheduleConvsReload();
        });
        es.addEventListener('message', e => {
            const d = JSON.parse(e.data || '{}');
            if ((d.conversation_id | 0) !== (state.convId | 0)) scheduleConvsReload();
        });
        es.addEventListener('conv_meta', e => {
            const d = JSON.parse(e.data || '{}'); const cid = d.conversation_id | 0;
            const prev = state.convMeta.get(cid) || {};
            const newPhoto = d.photo_ts ? `${API}/dm/conversations/${cid}/icon?ts=${encodeURIComponent(d.photo_ts)}` : prev.photo;
            const next = { ...prev, is_group: true, color: (typeof d.color === 'string' && d.color) ? d.color : prev.color || null, photo: newPhoto || prev.photo };
            state.convMeta.set(cid, next); updateEverywhere(cid);
            if ((cid | 0) === (state.convId | 0)) updateTopBar(next);
        });
        es.addEventListener('color_change', e => {
            const d = JSON.parse(e.data || '{}'); const cid = d.conversation_id | 0; const uid = d.user_id | 0;
            const cmap = { ...(window.MessagesApp.api.getColorMap(cid)) };
            if (d.color) cmap[uid] = d.color; else delete cmap[uid];
            window.MessagesApp.api.setColorMap(cid, cmap);
            if ((cid | 0) === (state.convId | 0)) updateAllMessageBorders();
        });
        es.onerror = () => { };
    }
    function startCatchup() { state.poll = setInterval(() => { fetchAfter(state.lastMsgId).catch(() => { }); }, 30000); }
    async function fetchAfter(lastId) {
        if (state.fetchingAfter) return;
        state.fetchingAfter = true;
        try {
            const j = await api(`/dm/conversations/${state.convId}/messages?after=${lastId}&limit=100`);
            const filtered = filterHidden(j.items);
            if (!filtered || !filtered.length) return;
            const stick = nearBottom(80);
            appendMessagesAscending(filtered);
            if (stick) { await afterPaint(); scrollToBottom(); }
            loadConversations().catch(() => { }); jumpBtn.sync();
        } finally { state.fetchingAfter = false; }
    }

    async function fetchFriends() {
        let arr = [];
        try { const j1 = await api(`/users/me/friends`); arr = j1.items || j1.friends || []; } catch { }
        if ((!arr || !arr.length) && state.meSlug) {
            try { const j2 = await api(`/users/${encodeURIComponent(state.meSlug)}/friends?offset=0&limit=500`); arr = j2.items || j2.friends || []; } catch { }
        }
        const norm = (arr || []).map(u => {
            const nu = u.user || u;
            const id = nu.id ?? nu.user_id ?? nu.friend_id ?? null;
            const username = nu.username ?? nu.first_username ?? null;
            const first_username = nu.first_username ?? nu.username ?? null;
            const profile_photo = nu.profile_photo ?? null;
            const bio = nu.bio ?? nu.bio_html ?? '';
            return { id, username, first_username, profile_photo, bio };
        }).filter(x => x.id);
        return norm;
    }

    async function startDmWith(u) {
        try {
            const og = u.first_username || u.username;
            const res = await api(`/dm/with/${encodeURIComponent(og)}`, { method: 'POST' });
            window.MessagesApp.closePicker?.();
            await loadConversations({ blockingMeta: true });
            const cid = res?.conversation_id || res?.id;
            if (cid) {
                const meta = { name: (u.display_name || u.first_username || u.username || 'User'), photo: u.profile_photo || DEFAULT_PFP_DM, is_group: false };
                setConvMeta(cid, meta);
                state.userCache.set(og, { username: og, photo: u.profile_photo || DEFAULT_PFP_DM, display_name: null, raw: u });
                scheduleSaveMeta(); openConversation(cid);
            } else if (state.allConvs[0]) {
                openConversation(state.allConvs[0].id);
            }
        } catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
    }

    async function maybeAutoRenameGroup() {
        const det = state.currentConvDetail || state.convDetailById.get(state.convId) || {};
        if (!det?.is_group) return;
        const meta = state.convMeta.get(state.convId) || {};
        if (meta.auto_title === false) return;
        const desired = computeDefaultGroupTitle(det.members || []);
        const current = (det.title || meta.name || '').trim();
        const stripAts = s => s.replace(/@/g, '');
        const sameIgnoringAts = (a, b) => stripAts(a) === stripAts(b);
        const isAutoNow = (current === '' || sameIgnoringAts(current, computeDefaultGroupTitle(det.members || [])));
        if (isAutoNow && !sameIgnoringAts(current, desired)) {
            await api(`/dm/conversations/${state.convId}/title`, { method: 'PATCH', body: { title: desired } });
            setConvMeta(state.convId, { name: desired, auto_title: true });
        }
    }

    async function sendMessage() {
        if (!state.convId || state.uploading) return;
        let text = $('text').value;
        if (!text && state.pendingFiles.length === 0) return;
        if (text.length > 10000) { alert('Message is over 10,000 characters. Please shorten it.'); return; }
        text = text.trim();

        const fd = new FormData(); fd.append('text', text);
        state.pendingFiles.forEach((f, i) => {
            const blob = new Blob([f.buf], { type: f.type || 'application/octet-stream' });
            const name = f.name || `file-${i}`;
            fd.append('files', blob, name);
            if (f.encoding) fd.append(`encoding_${name}`, f.encoding);
        });

        state.uploading = true; window.MessagesApp.syncSendUI?.();
        try {
            const r = await fetch(`${API}/dm/conversations/${state.convId}/messages`, { method: 'POST', credentials: 'include', body: fd });
            const t = await r.text(); if (!r.ok) throw new Error(t || r.statusText);
            let j = {}; try { j = JSON.parse(t); } catch { }
            if (j && j.id) state.lastMsgId = Math.max(state.lastMsgId, j.id | 0);
            $('text').value = ''; state.pendingFiles = []; window.MessagesApp.attachments.refreshChips();
            await fetchAfter(state.lastMsgId); loadConversations().catch(() => { });
            if (nearBottom()) { await afterPaint(); scrollToBottom(); }
        } catch (e) {
            alert(window.MessagesApp.utils.errMsg(e));
        } finally {
            state.uploading = false; window.MessagesApp.syncSendUI?.();
        }
    }

    // expose for wiring + safety
    Object.assign(window.MessagesApp, {
        chat: {
            fetchConvMeta, setConvMeta, updateTopBar, renderConvs, loadConversations, openConversation,
            startDmWith, fetchFriends, maybeAutoRenameGroup, sendMessage
        },
        revoke: { revokeAudioURLsIn, revokeObjectURLsIn }
    });

    // Boot (formerly your IIFE tail)
    async function boot() {
        await getMe();
        window.MessagesApp.utils.loadMetaCache();

        const urlMatch = location.pathname.match(/\/user\/([^\/]+)\/messages/i);
        const urlSlug = urlMatch ? decodeURIComponent(urlMatch[1]) : '';
        if (state.meSlug && urlSlug && urlSlug.toLowerCase() !== state.meSlug.toLowerCase()) {
            history.replaceState(null, '', `/user/${encodeURIComponent(state.meSlug)}/messages`);
        }

        await loadConversations({ blockingMeta: true });
        openGlobalStream();

        const last = loadLastDM();
        if (last && (last.meId | 0) === (state.meId | 0)) {
            const exists = state.allConvs.find(c => (c.id | 0) === (last.convId | 0));
            if (exists) { await openConversation(exists.id); }
        }
    }
    window.MessagesApp.boot = boot;
})();
