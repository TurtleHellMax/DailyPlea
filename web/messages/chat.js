(() => {
    const { API, $, state, DEFAULT_PFP_DM, DEFAULT_PFP_GROUP, GROUP_COLORS } = window.MessagesApp;
    const { esc, fmt, afterPaint, nearBottom, scrollToBottom,
        computeDefaultGroupTitle, pickName, pickPhoto, pickUsername,
        saveLastDM, loadLastDM, filterHidden, updateAllMessageBorders,
        scheduleSaveMeta } = window.MessagesApp.utils;
    const { api, getMe, syncMsgColors, getColorMap } = window.MessagesApp.api;
    const { initAudioPlayer, setPlayerTotal, unregisterPlayersIn } = window.MessagesApp.audio;
    const { renderAttachmentInline } = window.MessagesApp.attachments;

    const DBG = (...a) => { try { console.debug('[dm-ui]', ...a); } catch { } };

    // Helpers used across
    (function ensureMsgActionStyles() {
        if (document.getElementById('dm-msg-actions-styles')) return;
        const st = document.createElement('style');
        st.id = 'dm-msg-actions-styles';
        st.textContent = `
  #msgs{ overflow-x: hidden; }

  .msg{ position: relative; overflow: visible; max-width:100%; }

  /* Full-width vertical hover pad (same height as the message). This keeps hover active
     anywhere on the row, regardless of horizontal position. */
  .msg .hover-pad{
    position:absolute; top:0; bottom:0; left:-100vw; right:-100vw;
    /* clipped by #msgs overflow-x:hidden; */
    pointer-events:auto; z-index:1; /* sits under the rail/buttons */
    background: transparent; /* invisible */
  }

  /* Hover rail: centered vertically; shown on :hover, .hover, or when menu is open */
  .msg .msg-actions{
    position:absolute; top:50%;
    display:flex; flex-direction:column; gap:6px; align-items:center;
    opacity:0; pointer-events:none; transition:opacity .12s ease;
    z-index: 50; /* above hover-pad */
  }
  /* others -> rail to the right of bubble */
  .msg:not(.me) .msg-actions{ right:0; transform: translateX(calc(100% + 8px)) translateY(-50%); }
  /* me -> rail to the left of bubble */
  .msg.me .msg-actions{ left:0; transform: translateX(calc(-100% - 8px)) translateY(-50%); }

  .msg:hover .msg-actions,
  .msg.hover .msg-actions,           /* JS-driven hover */
  .msg.menu-open .msg-actions,       /* keep visible while menu open */
  .msg .msg-actions:hover{
    opacity:1; pointer-events:auto;
  }

  .react-btn, .bubble-menu-btn{
    border:1px solid var(--border,#333);
    background:var(--bg-2,#181818);
    color:inherit; border-radius:.35rem; padding:.2rem .45rem; cursor:pointer;
    line-height:1; font-size:14px;
  }
  .bubble-menu-btn[disabled]{ opacity:.45; cursor:default; }

  /* Menus open outward from the rail and are vertically centered with it */
  .msg:not(.me) .msg-actions .bubble-menu{  /* others -> open to the right */
    position:absolute; left:100%; top:50%; transform: translateY(-50%);
    margin-left:8px; display:none;
    background:var(--bg,#111); color:inherit;
    border:1px solid var(--border,#333); border-radius:.4rem; padding:6px; z-index:3000;
    min-width:160px; max-width:60vw; overflow:auto;
  }
  .msg.me .msg-actions .bubble-menu{        /* me -> open to the left */
    position:absolute; right:100%; top:50%; transform: translateY(-50%);
    margin-right:8px; display:none;
    background:var(--bg,#111); color:inherit;
    border:1px solid var(--border,#333); border-radius:.4rem; padding:6px; z-index:3000;
    min-width:160px; max-width:60vw; overflow:auto;
  }
  .bubble-menu .item{ padding:6px 8px; cursor:pointer; white-space:nowrap; }
  .bubble-menu .item:hover{ background:var(--bg-2,#181818); }
  .bubble-menu a{ color:inherit; text-decoration:none; }

  /* reaction chips row under message; hide when empty */
  .reactions{ display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-top:4px; }
  .reactions:empty{ display:none; }
  .rx-chip{
    border:1px solid var(--border,#333);
    background:var(--bg-2,#181818);
    border-radius:.35rem; padding:.15rem .4rem; line-height:1; cursor:pointer; font-size:13px;
  }
  .rx-chip.active{ outline:2px solid var(--accent,#6cf); }

  /* tiny fallback picker */
  #rx-fallback-pop{
    position:fixed; z-index:3001; background:var(--bg,#111); border:1px solid var(--border,#333);
    border-radius:.45rem; padding:6px; display:grid; grid-template-columns:repeat(6,28px); gap:6px;
    box-shadow:0 10px 30px rgba(0,0,0,.4);
  }
  #rx-fallback-pop .rx-emo{
    border:1px solid var(--border,#333); background:var(--bg-2,#181818);
    width:28px; height:28px; border-radius:.35rem; cursor:pointer; font-size:18px; line-height:1;
    display:flex; align-items:center; justify-content:center;
  }
  `;
        document.head.appendChild(st);
        DBG('styles injected: dm-msg-actions-styles');
    })();
    function isGroupChat() { return !!(state.currentConvDetail?.is_group); }
    function usernameFor(userId) {
        const det = state.currentConvDetail || {};
        const m = (det.members || []).find(u => (u.id | 0) === (userId | 0));
        const u = m || {}; return pickName(u) || 'user';
    }

    // make this name visible to overlays wiring

    window.MessagesApp.usernameFor = usernameFor;
    // --- use the app's API wrapper (path-only) ---
    async function apiGet(path) {
        // matches rest of the app; wrapper handles base URL, cookies, JSON, errors
        return await api(path, { method: 'GET' });
    }
    async function apiPost(path, body) {
        // pass the object body; wrapper will JSON-stringify + set headers
        return await api(path, { method: 'POST', body });
    }

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

            const rxRaw = (j.reactable ?? j.reactions_enabled);
            const delRaw = (j.allow_delete ?? j.message_delete_enabled);
            const winRaw = (j.delete_window_sec ?? j.message_delete_window_sec);

            const reactable = (rxRaw === undefined ? undefined : _asBool(rxRaw));
            const allowDelete = (delRaw === undefined ? undefined : _asBool(delRaw));
            const delWindowSec = (winRaw === undefined ? undefined : _asIntOrNull(winRaw));

            /* when writing meta for group/DM: */
            if (reactable !== undefined) {
                meta.reactions_enabled = reactable;
                meta.reactable = reactable;
            }
            if (allowDelete !== undefined) {
                meta.message_delete_enabled = allowDelete;
                meta.allow_delete = allowDelete;
                meta.message_delete_window_sec = allowDelete ? (delWindowSec ?? null) : null;
                meta.delete_window_sec = allowDelete ? (delWindowSec ?? null) : null;
            }

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

                if (reactable !== undefined) {
                    meta.reactions_enabled = reactable;
                    meta.reactable = reactable;
                }
                if (allowDelete !== undefined) {
                    meta.message_delete_enabled = allowDelete;
                    meta.allow_delete = allowDelete;
                    meta.message_delete_window_sec = allowDelete ? (delWindowSec ?? null) : null;
                    meta.delete_window_sec = allowDelete ? (delWindowSec ?? null) : null;
                }
            }

            const detail = {
                id: j.id,
                is_group: !!j.is_group,
                title: j.title || null,
                owner_id: j.owner_id || null,
                is_owner: !!j.is_owner,
                members: j.members || [],

                // cache on detail too, both names
                reactions_enabled: reactable,
                reactable,
                message_delete_enabled: allowDelete,
                allow_delete: allowDelete,
                message_delete_window_sec: allowDelete ? delWindowSec : null,
                delete_window_sec: allowDelete ? delWindowSec : null,
            };
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
        try { window.MessagesApp.ensureChatMenuWired?.(); } catch { }
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
            const needsFetch = !state.convMeta.has(it.id);
            if (needsFetch) state.convMeta.set(it.id, defaultMeta);
            if (needsFetch) fetchConvMeta(it.id).catch(() => { });
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
    function closeAllBubbleMenus() {
        document.querySelectorAll('.bubble-menu').forEach(el => el.style.display = 'none');
    }

    function _coalesce() { for (let i = 0; i < arguments.length; i++) { const v = arguments[i]; if (v !== undefined && v !== null) return v; } return undefined; }
    const _asBool = v => v === true || v === 1 || String(v).toLowerCase?.() === '1' || String(v).toLowerCase?.() === 'true';
    const _asIntOrNull = v => (v == null || v === 'null' || v === '') ? null : (Number(v) | 0);

    function getPolicyForCurrentConv() {
        const det = state.currentConvDetail || {};
        const meta = state.convMeta.get(state.convId) || {};

        // Prefer settings/meta first, then fall back to detail
        const rawRx = _coalesce(meta.reactions_enabled, meta.reactable, det.reactions_enabled, det.reactable, undefined);
        const rawDel = _coalesce(meta.message_delete_enabled, meta.allow_delete, det.message_delete_enabled, det.allow_delete, undefined);
        const rawWin = _coalesce(meta.message_delete_window_sec, meta.delete_window_sec, det.message_delete_window_sec, det.delete_window_sec, undefined);

        const reactionsEnabled = (rawRx === undefined ? null : _asBool(rawRx));
        const deletionEnabled = (rawDel === undefined ? null : _asBool(rawDel));
        const windowSec = (rawWin === undefined ? null : _asIntOrNull(rawWin));

        return { reactionsEnabled, deletionEnabled, windowSec };
    }

    function attachMessageMenu(root, message) {
        const atts = (message.attachments || []);
        const now = Date.now();
        let { reactionsEnabled, deletionEnabled, windowSec } = getPolicyForCurrentConv();
        const policyUnknown = (deletionEnabled == null);

        // default reactions to true if policy is not yet known
        if (reactionsEnabled == null) reactionsEnabled = true;

        // Convo meta + message timestamp for “effective from” checks
        const meta = state.convMeta.get(state.convId) || {};
        const tsSec = root.dataset.ts ? (+root.dataset.ts || null) : null;
        let rxEnabled = (typeof message.reactable === 'boolean') ? message.reactable
            : (reactionsEnabled == null ? true : !!reactionsEnabled);
        if (rxEnabled && meta.reactions_effective_from_ts && tsSec) {
            rxEnabled = (tsSec * 1000) >= meta.reactions_effective_from_ts;
        }
        const canReact = !!rxEnabled;

        const senderIsMe = ((message.sender_id | 0) === (state.meId | 0));
        const baseDeletable = (message.deletable == null) ? senderIsMe : !!message.deletable;

        let deadlineOk = true;
        let effectiveOk = true;
        const effFromTs = (state.convMeta.get(state.convId) || {}).delete_effective_from_ts || null;

        if (message.delete_deadline_at) {
            deadlineOk = new Date(message.delete_deadline_at).getTime() >= now;
        } else if (deletionEnabled && windowSec != null && message.created_at) {
            const createdMs = new Date(message.created_at).getTime();
            deadlineOk = (createdMs + windowSec * 1000) >= now;
        }
        if (effFromTs && message.created_at) {
            effectiveOk = new Date(message.created_at).getTime() >= effFromTs;
        }
        const deletable = (policyUnknown
            ? (baseDeletable && deadlineOk)             // optimistic until settings arrive
            : (deletionEnabled && baseDeletable && deadlineOk && effectiveOk));

        // hover pad
        let pad = root.querySelector(':scope > .hover-pad');
        if (!pad) { pad = document.createElement('div'); pad.className = 'hover-pad'; root.appendChild(pad); }

        // vertical rail
        let actions = root.querySelector(':scope > .msg-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'msg-actions';
            actions.dataset.forMsg = message.id;
            root.appendChild(actions);
        } else {
            actions.innerHTML = '';
        }

        const hasMenuItems = !!(atts.length || deletable);

        // show ⋮ only when there are items
        const dotsBtn = document.createElement('button');
        dotsBtn.type = 'button';
        dotsBtn.className = 'bubble-menu-btn';
        dotsBtn.textContent = '⋮';
        actions.appendChild(dotsBtn);
        if (!hasMenuItems) { dotsBtn.style.opacity = '.55'; dotsBtn.title = 'No actions'; }

        // 🙂 under ⋮
        if (canReact) {
            const rbtn = document.createElement('button');
            rbtn.type = 'button';
            rbtn.className = 'react-btn';
            rbtn.setAttribute('aria-label', 'React');
            rbtn.textContent = '🙂';
            rbtn.onclick = (e) => {
                e.stopPropagation();
                const wrap = rbtn.closest('.msg');
                wrap && wrap.classList.add('rx-open');   // hide ⋮ while picker open
                window.MessagesApp.reactions?.openPicker?.(rbtn, message);
            };
            actions.appendChild(rbtn);
        }

        // dropdown (only download/delete)
        const menu = document.createElement('div');
        menu.className = 'bubble-menu';
        if (hasMenuItems) {
            const parts = [];
            if (atts.length) {
                parts.push(...atts.map(a => {
                    const href = `${API}/dm/attachments/${a.id}/download`;
                    const filename = esc(a.filename || 'attachment');
                    return `<div class="item"><a href="${href}" download="${filename}">Download ${filename}</a></div>`;
                }));
            }
            if (deletable) {
                parts.push(`<div class="item"><a href="#" class="msg-del-link">Delete message</a></div>`);
            }
            menu.innerHTML = parts.join('');
        }
        actions.appendChild(menu);

        // click ⋮ → only toggle if there are items
        dotsBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (!hasMenuItems) return;           // clickable, but no-op without items
            const open = menu.style.display === 'block';
            closeAllBubbleMenus();
            menu.style.display = open ? 'none' : 'block';
            root.classList.toggle('menu-open', !open); // hide 🙂 while menu open
        });

        // downloads fixer
        menu.querySelectorAll('a[download]').forEach(a => {
            const href = a.getAttribute('href') || '';
            const name = a.getAttribute('download') || 'attachment';
            window.MessagesApp.attachments?.fixDownloadLink?.(a, href, name, undefined);
        });

        // delete
        const delLink = menu.querySelector('.msg-del-link');
        if (delLink) {
            delLink.addEventListener('click', async (e) => {
                e.preventDefault(); e.stopPropagation();
                menu.style.display = 'none';
                root.classList.remove('menu-open');
                try {
                    await window.MessagesApp.api.api(`/dm/messages/${message.id}`, { method: 'DELETE' });
                    const meta = root.querySelector(':scope > .meta');
                    root.classList.add('deleted');
                    root.innerHTML = `<div class="sysmsg-inner">Message deleted</div>`;
                    if (meta) root.appendChild(meta);
                } catch (err) {
                    alert(window.MessagesApp.utils.errMsg(err));
                }
            });
        }
    }

    // Close bubble menus on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.bubble-menu') && !e.target.closest('.bubble-menu-btn')) {
            document.querySelectorAll('.bubble-menu').forEach(el => el.style.display = 'none');
            document.querySelectorAll('.msg.menu-open').forEach(el => el.classList.remove('menu-open'));
        }
    });

    (function installMsgHoverWiring() {
        const box = $('msgs');
        if (!box) { DBG('hover wiring: #msgs not found (will rely on CSS only)'); return; }
        if (box.__hoverWired) return;
        box.__hoverWired = true;

        const onOver = (e) => {
            const m = e.target && e.target.closest && e.target.closest('.msg');
            if (!m || m.classList.contains('sysmsg')) return;
            if (!m.classList.contains('hover')) {
                m.classList.add('hover');
                DBG('msg hover ON', { msgId: m.dataset.msgId });
            }
        };
        const onOut = (e) => {
            const m = e.target && e.target.closest && e.target.closest('.msg');
            if (!m) return;
            // Only clear when pointer actually leaves this .msg subtree
            const to = e.relatedTarget;
            if (!to || !m.contains(to)) {
                m.classList.remove('hover');
                DBG('msg hover OFF', { msgId: m.dataset.msgId });
            }
        };

        box.addEventListener('mouseover', onOver, true);
        box.addEventListener('mouseout', onOut, true);
        DBG('hover wiring installed');
    })();

    // Rendering a message
    function renderMessage(m, showFrom = false) {
        const isSystem = (m.kind === 'system');
        const wrap = document.createElement('div');
        wrap.className = (isSystem ? 'msg sysmsg' : ('msg' + (m.sender_id === state.meId ? ' me' : '')));
        wrap.dataset.msgId = m.id;
        if (!isSystem) wrap.dataset.senderId = m.sender_id || '';
        if (m.created_at) wrap.dataset.ts = String(Math.round(new Date(m.created_at).getTime() / 1000));
        // Preserve per-message snapshots for later re-wiring
        if (m.reactable !== undefined) wrap.dataset.reactable = m.reactable ? '1' : '0';
        if (m.deletable !== undefined) wrap.dataset.deletable = m.deletable ? '1' : '0';
        if (m.delete_deadline_at) wrap.dataset.deleteDeadline = m.delete_deadline_at;

        if (!isSystem && isGroupChat() && showFrom) {
            const label = document.createElement('div'); label.className = 'from'; label.textContent = usernameFor(m.sender_id); wrap.appendChild(label);
        }

        if (m.text) wrap.insertAdjacentHTML('beforeend', '<div>' + esc(m.text) + '</div>');
        if (!isSystem) {
            (m.attachments || []).forEach(a => {
                const url = `${API}/dm/attachments/${a.id}/download?inline=1`;
                if ((a.mime_type || '').startsWith('image/')) wrap.insertAdjacentHTML('beforeend', `<img class="att" data-att-id="${a.id}" data-filename="${esc(a.filename || 'attachment')}" src="${url}">`);
                else if ((a.mime_type || '').startsWith('video/')) wrap.insertAdjacentHTML('beforeend', `<video class="att" data-att-id="${a.id}" data-filename="${esc(a.filename || 'attachment')}" src="${url}" controls></video>`);
                else if ((a.mime_type || '').startsWith('audio/')) {
                    wrap.insertAdjacentHTML('beforeend', `
            <div class="audp" data-att-id="${a.id}" data-filename="${esc(a.filename || 'audio')}">
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
        if (!isSystem) {
            attachMessageMenu(wrap, m);
            window.MessagesApp.refreshMessageActions = () => {
                document.querySelectorAll('.msg').forEach(root => {
                    if (root.classList.contains('sysmsg')) return;
                    const ds = root.dataset || {};
                    const msg = {
                        id: +ds.msgId || +ds.id || 0,
                        sender_id: +ds.senderId || 0,
                        created_at: ds.ts ? new Date(+ds.ts * 1000).toISOString() : null,
                        // carry over snapshots if present
                        reactable: (ds.reactable == null) ? undefined : (ds.reactable === '1' || ds.reactable === 'true'),
                        deletable: (ds.deletable == null) ? undefined : (ds.deletable === '1' || ds.deletable === 'true'),
                        delete_deadline_at: ds.deleteDeadline || null,
                        // presence of atts is enough for a "Download" item
                        attachments: Array.from(root.querySelectorAll('[data-att-id], [data-download]'))
                            .map(el => ({
                                id: el.dataset.attId ? (+el.dataset.attId || null) : null,
                                filename: el.getAttribute('download') || el.dataset.filename || 'attachment'
                            }))
                            .filter(a => a.id != null)
                    };
                    attachMessageMenu(root, msg);
                });
            };
            window.MessagesApp.reactions?.attachBar(wrap, m);
        }

        DBG('renderMessage', {
            id: m.id,
            sys: isSystem,
            me: (m.sender_id === state.meId),
            actions: !!wrap.querySelector(':scope > .msg-actions')
        });

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
        // hydrate policy from /settings when available
        try {
            if (window.MessagesApp.syncConvSettings) {
                await window.MessagesApp.syncConvSettings(id);
            } else {
                // tiny fallback if ui-overlays didn't define it
                const r = await api(`/dm/conversations/${id}/settings`, { method: 'GET' });
                const s = (r && r.settings) ? r.settings : (r || {});
                const toTs = v => { const t = v ? new Date(v).getTime() : NaN; return Number.isFinite(t) ? t : null; };
                const meta = state.convMeta.get(id) || {};
                meta.reactions_enabled = (s.reactable ?? meta.reactions_enabled);
                meta.reactions_mode = (s.reaction_mode || meta.reactions_mode || 'both');
                meta.reactions_effective_from_ts = toTs(s.reactions_effective_from);
                meta.message_delete_enabled = (s.allow_delete ?? meta.message_delete_enabled);
                meta.message_delete_window_sec = (s.allow_delete ? (s.delete_window_sec ?? null) : null);
                meta.delete_effective_from_ts = toTs(s.delete_effective_from);
                state.convMeta.set(id, meta);
            }
        } catch { }

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
        try { window.MessagesApp.refreshMessageActions?.(); } catch { }
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
        es.addEventListener('message', async () => { await fetchAfter(state.lastMsgId); });
        window.MessagesApp.reactions?.bindStream(es, id);
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
            const j = await api(`/dm/conversations/${state.convId}/messages`, { method: 'POST', body: fd });
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

    /* ==========================
       Reactions controller (with fallback)
       ========================== */
    (() => {
        // Try to use host UI if present; else fall back to tiny inline picker/render
        const UI = window.UIOverlays || {};

        function simpleRenderReactionBar(el, items, { disabled, customUrlFor, onOpenPicker, onToggle }) {
            el.innerHTML = '';
            (items || []).forEach(it => {
                const key = it.reaction_key || it.key || null;
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'rx-chip' + (it.reacted_by_me ? ' active' : '');
                if (it.kind === 'custom' && it.custom_emoji_id) {
                    const url = customUrlFor ? (customUrlFor(it.custom_emoji_id) || '') : '';
                    if (url) {
                        const img = document.createElement('img');
                        img.src = url; img.alt = 'custom'; img.width = 16; img.height = 16; img.style.verticalAlign = 'middle';
                        btn.append(img, document.createTextNode(' ' + (it.count | 0)));
                    } else {
                        // fallback glyph when library missing — still show count so the bar exists
                        btn.textContent = '★ ' + (it.count | 0);
                    }
                } else {
                    const uni = it.unicode || it.emoji || '⭐';
                    btn.textContent = uni + ' ' + (it.count | 0);
                }
                btn.onclick = (e) => { e.stopPropagation(); if (key && onToggle) onToggle(key); };
                el.appendChild(btn);
            });
            // no "Add reaction" button here; picker is opened by the hover rail's 🙂 button
        }

        class SimpleReactionPickerUI {
            constructor(opts) { this.opts = opts || {}; }
            open(msgId, anchorEl) {
                const old = document.getElementById('rx-fallback-pop'); if (old) old.remove();
                const pop = document.createElement('div'); pop.id = 'rx-fallback-pop';
                const EMO = ['👍', '❤️', '😂', '😮', '😢', '😡', '🎉', '🙏', '🔥', '👏', '👌', '🤝'];
                EMO.forEach(u => {
                    const b = document.createElement('button'); b.type = 'button'; b.className = 'rx-emo'; b.textContent = u;
                    b.onclick = async (e) => {
                        e.stopPropagation();
                        try {
                            await this.opts.toggleReaction?.(msgId, { kind: 'emoji', unicode: u });
                            this.onPicked && this.onPicked({ kind: 'emoji', unicode: u });
                        } finally { pop.remove(); }
                    };
                    pop.appendChild(b);
                });
                // position near anchor
                const rect = anchorEl?.getBoundingClientRect?.() || { left: 30, bottom: 30 };
                pop.style.left = Math.max(6, Math.min(window.innerWidth - 200, rect.left)) + 'px';
                pop.style.top = Math.min(window.innerHeight - 60, (rect.bottom + 6)) + 'px';
                document.body.appendChild(pop);
                // outside click to close
                setTimeout(() => {
                    const close = (ev) => { if (!pop.contains(ev.target)) { pop.remove(); this.onClosed && this.onClosed(); document.removeEventListener('click', close); } };
                    document.addEventListener('click', close);
                }, 0);
            }
        }

        const ReactionPickerUI = UI.ReactionPickerUI || SimpleReactionPickerUI;
        const renderReactionBar = UI.renderReactionBar || simpleRenderReactionBar;

        const LIB = new Map();         // custom_emoji_id -> url
        const MSG_BAR = new Map();     // msgId -> { barEl, meta }
        let picker = null;

        // --- use the app's API wrapper when available (it dedupes /dm/reactions/custom/library)
        const callApi = () => (window.MessagesApp?.api?.api);

        // generic JSON fetch via wrapper (or fall back to fetch)
        async function fetchJSON(url, opt) {
            const api = callApi();
            if (api && url.startsWith(API)) {
                const path = url.slice(API.length) || '/';
                const method = (opt?.method || 'GET').toUpperCase();
                const body = opt?.body;
                const resp = await api(path, body ? { method, body } : { method });
                return resp || {};
            }
            const r = await fetch(url, { credentials: 'include', ...(opt || {}) });
            const t = await r.text();
            if (!r.ok) throw new Error(t || r.statusText);
            try { return JSON.parse(t); } catch { return {}; }
        }

        // ——— single-flight + exponential backoff for the custom library
        let _libCache = null, _libInflight = null, _libLastFail = 0, _libBackoff = 0;

        // single-flight + backoff kept the same; only the call changes
        async function loadLibraryOnce() {
            if (_libCache) return _libCache;
            if (_libInflight) return _libInflight;

            const now = Date.now();
            if (_libLastFail && (now - _libLastFail) < _libBackoff) return _libCache || [];

            _libInflight = (async () => {
                try {
                    const j = await apiGet('/dm/reactions/custom/library');
                    const items = Array.isArray(j?.items) ? j.items : (j?.items || []);
                    items.forEach(e => { if (e?.id && e?.url) LIB.set(+e.id, e.url); });
                    _libCache = items; _libLastFail = 0; _libBackoff = 0;
                    return _libCache;
                } catch (e) {
                    _libLastFail = Date.now();
                    _libBackoff = Math.min(300000, _libBackoff ? _libBackoff * 2 : 5000);
                    return _libCache || [];
                } finally { _libInflight = null; }
            })();

            return _libInflight;
        }

        function urlForCustom(id) { return LIB.get(+id) || null; }
        async function listForMessage(msgId) {
            return await apiGet(`/dm/messages/${msgId}/reactions`);
        }

        async function toggleByKey(msgId, reaction_key) {
            // send the exact shape the server expects
            return await apiPost(`/dm/messages/${msgId}/reactions/toggle`, { reaction_key });
        }

        function ensureBar(wrap) {
            let bar = wrap.querySelector(':scope > .reactions');
            if (!bar) {
                bar = document.createElement('div');
                bar.className = 'reactions';
                const meta = wrap.querySelector(':scope > .meta');
                (meta ? meta.after(bar) : wrap.appendChild(bar));
            }
            return bar;
        }

        async function renderBarFor(msgId) {
            const info = MSG_BAR.get(msgId);
            if (!info) return;
            const { barEl } = info;

            let j = {};
            try { j = await listForMessage(msgId); } catch { j = {}; }
            const items = j.items || [];
            const reactable = !!j.reactable;

            barEl.innerHTML = '';
            renderReactionBar(barEl, items, {
                disabled: !reactable,
                customUrlFor: urlForCustom,
                onOpenPicker: () => openPicker(barEl, { id: msgId, reactable }),
                onToggle: async (reaction_key) => {
                    if (reaction_key) { await toggleByKey(msgId, reaction_key); await renderBarFor(msgId); }
                }
            });
        }

        async function attachBar(wrap, message) {
            await loadLibraryOnce();
            const bar = ensureBar(wrap);
            MSG_BAR.set(message.id, { barEl: bar, meta: { convId: state.convId } });
            await renderBarFor(message.id);
        }

        function toKey(payload) {
            if (payload?.kind === 'emoji' && payload.unicode) return `u:${payload.unicode}`;
            if (payload?.kind === 'custom' && payload.custom_emoji_id) return `c:${payload.custom_emoji_id}`;
            return null;
        }

        function openPicker(anchorEl, message) {
            if (!message?.id) return;
            if (!picker) {
                picker = new ReactionPickerUI({
                    apiBase: API,
                    async toggleReaction(msgId, payload) {
                        const key = toKey(payload);
                        if (!key) throw new Error('Bad reaction payload');
                        await toggleByKey(msgId, key);     // <- actually hits POST /reactions/toggle
                    }
                    // listReactions is optional for the simple picker
                });

                // when a choice is made, close & re-render
                picker.onPicked = async () => {
                    const mid = lastPickerMsgId; if (mid) await renderBarFor(mid);
                    // clear rx-open on the message row when picker closes after pick
                    const row = document.querySelector(`.msg[data-msg-id="${mid}"]`);
                    row && row.classList.remove('rx-open');
                };

                // optional: if your fallback picker closes via outside click, expose this hook
                if (!picker.onClosed) picker.onClosed = () => {
                    const mid = lastPickerMsgId;
                    const row = document.querySelector(`.msg[data-msg-id="${mid}"]`);
                    row && row.classList.remove('rx-open');
                };
            }

            lastPickerMsgId = message.id;

            // mark the row as "reaction-open" to hide 3-dots
            const row = anchorEl?.closest?.('.msg');
            row && row.classList.add('rx-open');

            picker.open(message.id, anchorEl);

            // If using the fallback popup (#rx-fallback-pop), watch for its removal to clear rx-open
            setTimeout(() => {
                const closeWatcher = (ev) => {
                    if (!document.getElementById('rx-fallback-pop')) {
                        row && row.classList.remove('rx-open');
                        document.removeEventListener('click', closeWatcher, true);
                    }
                };
                document.addEventListener('click', closeWatcher, true);
            }, 0);
        }

        let lastPickerMsgId = null;

        function bindStream(es /* EventSource */, convId) {
            const handler = async (e) => {
                try {
                    const d = JSON.parse(e.data || '{}');
                    const mid = d.message_id || d.msg_id || d.id;
                    if (mid) await renderBarFor(+mid);
                } catch { }
            };
            ['reaction', 'reactions', 'reaction_update'].forEach(evt => es.addEventListener(evt, handler));
        }

        async function init() { await loadLibraryOnce(); }

        // expose
        window.MessagesApp.reactions = { init, attachBar, openPicker, bindStream };
    })();

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
        try { await window.MessagesApp.reactions?.init(); } catch { }

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

    // ========== Top-right chat menu wiring (robust) ==========
    (function installChatMenuWiring() {
        let wired = false, ui = null;

        function getCtx() {
            const s = window.MessagesApp.state || {};
            const det = s.currentConvDetail || {};
            const meta = s.convMeta?.get(s.convId) || {};
            const isGroup = !!det.is_group;
            const isOwner = !!det.is_owner || ((det.owner_id | 0) === (s.meId | 0));
            return {
                isGroup,
                isOwner,
                reactionsEnabled: !!(meta.reactions_enabled ?? det.reactions_enabled),
                messageDeleteEnabled: !!(meta.message_delete_enabled ?? det.message_delete_enabled),
            };
        }

        function tryWire() {
            if (wired) return;
            const ChatMenuUI = window.UIOverlays && window.UIOverlays.ChatMenuUI;
            const menuEl = document.getElementById('chat-menu');
            const btnEl = document.getElementById('chat-menu-btn');
            if (!ChatMenuUI || !menuEl || !btnEl) return; // keep waiting

            ui = new ChatMenuUI({
                menuEl, buttonEl: btnEl,
                getContext: getCtx,
                handlers: {
                    rename: () => window.MessagesApp.renameGroup?.(),
                    manage: () => {
                        const ids = (window.MessagesApp.state.currentConvDetail?.members || []).map(m => m.id);
                        window.MessagesApp.openFriendPicker?.('group-edit', { preselectIds: ids });
                    },
                    viewMembers: () => {
                        const ids = (window.MessagesApp.state.currentConvDetail?.members || []).map(m => m.id);
                        window.MessagesApp.openFriendPicker?.('view', { preselectIds: ids });
                    },
                    restyle: () => window.MessagesApp.restyleOverlay?.show?.(),
                    myColor: () => window.MessagesApp.myColorOverlay?.show?.(),
                    toggleReactions: async () => {
                        const s = window.MessagesApp.state; const cid = s.convId;
                        const meta = s.convMeta.get(cid) || {};
                        const cur = !!meta.reactions_enabled;
                        try {
                            await window.MessagesApp.api.api(`/dm/conversations/${cid}/settings`, {
                                method: 'PATCH',
                                body: { reactable: !cur }
                            });
                            window.MessagesApp.chat.setConvMeta(cid, { reactions_enabled: !cur, reactable: !cur });
                            if (s.currentConvDetail) {
                                s.currentConvDetail.reactions_enabled = !cur;
                                s.currentConvDetail.reactable = !cur;
                            }
                            window.MessagesApp.renderChatMenu?.();
                        } catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
                    },
                    toggleDeletion: async () => {
                        const s = window.MessagesApp.state; const cid = s.convId;
                        const meta = s.convMeta.get(cid) || {};
                        const cur = !!meta.message_delete_enabled;
                        try {
                            await window.MessagesApp.api.api(`/dm/conversations/${cid}/settings`, {
                                method: 'PATCH',
                                body: { allow_delete: !cur }
                            });
                            window.MessagesApp.chat.setConvMeta(cid, { message_delete_enabled: !cur, allow_delete: !cur });
                            if (s.currentConvDetail) {
                                s.currentConvDetail.message_delete_enabled = !cur;
                                s.currentConvDetail.allow_delete = !cur;
                            }
                            window.MessagesApp.renderChatMenu?.();
                        } catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
                    },
                    deleteChat: async () => {
                        const s = window.MessagesApp.state; const cid = s.convId;
                        if (!cid) return;
                        if (!confirm('Delete this chat for you? This won’t remove it for others.')) return;
                        try {
                            await window.MessagesApp.api.api(`/dm/conversations/${cid}/hide`, { method: 'POST' });
                            await window.MessagesApp.chat.loadConversations();
                            const next = s.allConvs.find(c => (c.id | 0) !== (cid | 0));
                            if (next) await window.MessagesApp.chat.openConversation(next.id);
                            else {
                                document.getElementById('msgs').innerHTML = '<div id="pad-top"></div><div id="pad-bottom"></div>';
                                s.convId = 0;
                                document.getElementById('chat-title').textContent = 'Direct Message';
                            }
                        } catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
                    },
                    leave: () => window.MessagesApp.leaveGroup?.(),
                    blockGroup: () => window.MessagesApp.blockGroup?.(),
                    blockUser: () => window.MessagesApp.blockUser?.(),
                }
            });

            // allow app to refresh labels
            window.MessagesApp.renderChatMenu = () => ui.render();
            wired = true;
        }

        // try now
        tryWire();

        // try when DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', tryWire, { once: true });
        } else {
            setTimeout(tryWire, 0);
        }

        // try when nodes appear later
        const mo = new MutationObserver(() => { tryWire(); if (wired) mo.disconnect(); });
        mo.observe(document.documentElement, { childList: true, subtree: true });

        // expose a manual nudge
        window.MessagesApp.ensureChatMenuWired = tryWire;
    })();

    window.MessagesApp.boot = boot;
})();
