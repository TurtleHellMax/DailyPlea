
(function (global) {
    window.MessagesApp = window.MessagesApp || {};
    window.MessagesApp.useNativeMsgRail = true;
    'use strict';

    // === DEBUG: raw network tap (reactions endpoint only) ===
    (function tapFetchForReactions() {
        if (!('fetch' in window) || window.__rxFetchTap) return;
        window.__rxFetchTap = true;
        const origFetch = window.fetch.bind(window);

        window.fetch = async (...args) => {
            const [url, init = {}] = args;
            const isRx = typeof url === 'string' && /\/dm\/messages\/\d+\/reactions\/toggle$/.test(url);
            if (isRx) {
                let bodyPreview = init.body;
                try {
                    if (bodyPreview && typeof bodyPreview !== 'string' && !(bodyPreview instanceof FormData)) {
                        bodyPreview = JSON.stringify(bodyPreview);
                    }
                } catch { }
                console.debug('[rx][fetch->]', {
                    url, method: (init.method || 'GET').toUpperCase(),
                    headers: init.headers, body: bodyPreview
                });
            }

            try {
                const res = await origFetch(...args);
                if (isRx) {
                    const clone = res.clone();
                    let text = '';
                    try { text = await clone.text(); } catch { }
                    const headers = {};
                    try { res.headers.forEach((v, k) => { headers[k] = v; }); } catch { }
                    console.debug('[rx][fetch<-]', {
                        status: res.status, statusText: res.statusText,
                        headers, body: text
                    });
                }
                return res;
            } catch (e) {
                if (isRx) console.error('[rx][fetch x]', e);
                throw e;
            }
        };
    })();

    /* ---------- tiny utils ---------- */
    const $id = (s) => document.getElementById(s);
    const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const by = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

    (function ensureMsgMetaHelper() {
        const MA = (window.MessagesApp ||= {});
        if (MA.extractMsgMeta) return;

        MA.extractMsgMeta = function (msgEl) {
            const pick = (el) => (el && el.dataset) ? el.dataset : {};
            const probe = msgEl.matches?.('[data-msg-id],[data-id],[data-mid],[data-message-id],[data-sender-id],[data-user-id],[data-ts],[data-time],[data-created-at]')
                ? msgEl
                : (msgEl.querySelector?.('[data-msg-id],[data-id],[data-mid],[data-message-id],[data-sender-id],[data-user-id],[data-ts],[data-time],[data-created-at]') || msgEl);
            const d = pick(probe);

            let id = +(d.msgId || d.id || d.mid || d.messageId || 0);
            if (!id && msgEl.id) { const m = /(\d+)$/.exec(msgEl.id); if (m) id = +m[1]; }

            let senderId = +(d.senderId || d.userId || d.uid || 0);

            let tsSec = null;
            const rawTs = d.ts || d.time || d.createdAt || d.created_at || null;
            if (rawTs) {
                if (/^\d+$/.test(rawTs)) {
                    const n = +rawTs; tsSec = (n > 2e10) ? Math.round(n / 1000) : n;
                } else {
                    const t = new Date(rawTs).getTime();
                    if (Number.isFinite(t)) tsSec = Math.round(t / 1000);
                }
            } else {
                const tEl = msgEl.querySelector?.('time[datetime]');
                if (tEl?.getAttribute) {
                    const t = new Date(tEl.getAttribute('datetime')).getTime();
                    if (Number.isFinite(t)) tsSec = Math.round(t / 1000);
                }
            }
            return { id, senderId, tsSec };
        };
    })();

    /* =====================================================
       Friend Picker (DM / Group Create / Group Edit / View)
       ===================================================== */
    class FriendPickerUI {
        /**
         * @param {Object} cfg
         * @param {() => Promise<Array<{id:number, username?:string, first_username?:string, profile_photo?:string, bio?:string}>>} cfg.fetchFriends
         * @param {(u:object)=>void} cfg.onStartDm
         * @param {(ids:number[])=>void} cfg.onCreateGroup
         * @param {(delta:{add:number[], remove:number[]})=>void} cfg.onEditGroup
         * @param {() => {isGroup:boolean, meId:number}} cfg.getConvContext
         * @param {(uid:number)=>string} [cfg.usernameFor]
         * @param {string} cfg.DEFAULT_PFP_DM
         */
        constructor(cfg = {}) {
            this.cfg = Object.assign({
                fetchFriends: async () => [],
                onStartDm: () => { },
                onCreateGroup: () => { },
                onEditGroup: () => { },
                getConvContext: () => ({ isGroup: false, meId: 0 }),
                usernameFor: (id) => `user-${id}`,
                DEFAULT_PFP_DM: '',
            }, cfg);
            this.state = { mode: 'dm', friendsCache: [], idToFriend: new Map(), selectedIds: new Set(), initialSelectedIds: new Set() };
            this._ensure();
        }
        _ensure() {
            // uses existing DOM shell if you have one, otherwise creates a minimal one
            this.overlay = $id('overlay');
            if (!this.overlay) {
                this.overlay = document.createElement('div');
                this.overlay.id = 'overlay';
                this.overlay.className = 'overlay';
                this.overlay.style.display = 'none';
                this.overlay.innerHTML = `
        <div class="sheet" style="width:min(680px,96vw)">
            <h3 id="sheet-title">People</h3>
            <input id="user-q" class="cs-search" placeholder="Search…" />
            <div id="selected-chips" style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0"></div>
            <div id="user-list" style="display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow:auto"></div>
            <div id="group-cta" style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
                <button class="btn secondary" id="btn-cancel" type="button">Cancel</button>
                <button class="btn" id="btn-group-submit" type="button" disabled>Create Group</button>
            </div>
        </div>`;
                document.body.appendChild(this.overlay);
            }
            this.userList = $id('user-list');
            on(this.overlay, 'click', (e) => { if (e.target === this.overlay) this.close(); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
            on($id('user-q'), 'input', () => this.renderFriends(this.state.friendsCache));
            on($id('btn-cancel'), 'click', () => this.close());
            on($id('btn-group-submit'), 'click', () => this._submit());
        }
        async open(mode = 'dm', opts = {}) {
            this.state.mode = mode;
            this.state.selectedIds = new Set(opts.preselectIds || []);
            this.state.initialSelectedIds = new Set(opts.preselectIds || []);
            this.overlay.style.display = 'flex';
            const title = $id('sheet-title');
            if (title) {
                title.textContent = mode === 'dm' ? 'Start a conversation'
                    : mode === 'group-create' ? 'Create a Group'
                        : mode === 'group-edit' ? 'Edit Group Members'
                            : 'Group Members';
            }
            const cta = $id('group-cta');
            if (cta) cta.style.display = (mode === 'group-create' || mode === 'group-edit') ? '' : 'none';
            this._refreshGroupSubmitState();
            const list = await this.cfg.fetchFriends();
            this.renderFriends(list);
        }
        close() { this.overlay.style.display = 'none'; }
        _refreshSelectedChips() {
            const box = $id('selected-chips'); if (!box) return;
            box.innerHTML = '';
            [...this.state.selectedIds].forEach(uid => {
                const u = this.state.idToFriend.get(uid) || {};
                const label = u.display_name || u.name || u.first_username || u.username || `user-${uid}`;
                const chip = document.createElement('div');
                chip.className = 'chip';
                chip.innerHTML = `<span>${esc(label)}</span><span class="x" title="Remove">✕</span>`;
                on(chip.querySelector('.x'), 'click', (e) => { e.stopPropagation(); this.state.selectedIds.delete(uid); this.renderFriends(this.state.friendsCache); this._refreshSelectedChips(); this._refreshGroupSubmitState(); });
                box.append(chip);
            });
        }
        _refreshGroupSubmitState() {
            const btn = $id('btn-group-submit'); if (!btn) return;
            if (this.state.mode === 'group-create') {
                btn.textContent = 'Create Group';
                btn.disabled = (this.state.selectedIds.size < 2);
            } else if (this.state.mode === 'group-edit') {
                btn.textContent = 'Save Changes';
                const before = this.state.initialSelectedIds, after = this.state.selectedIds;
                const changed = (before.size !== after.size) || [...after].some(x => !before.has(x));
                btn.disabled = !changed;
            } else {
                btn.textContent = 'Close'; btn.disabled = false;
            }
        }
        renderFriends(list = []) {
            this.state.friendsCache = list;
            this.state.idToFriend.clear();
            list.forEach(u => this.state.idToFriend.set(u.id, u));
            if (!this.userList) return;
            this.userList.innerHTML = '';
            const q = ($id('user-q')?.value || '').trim().toLowerCase();
            const items = list.filter(u => !q || (u.username || '').toLowerCase().includes(q) || (u.first_username || '').toLowerCase().includes(q) || (u.bio || '').toLowerCase().includes(q));
            const mode = this.state.mode;
            items.forEach(u => {
                const row = document.createElement('div');
                row.className = 'person';
                const label = u.display_name || u.name || u.first_username || u.username || 'User';
                const checked = this.state.selectedIds.has(u.id);
                row.innerHTML = `
        <img class="pfp ${u.profile_photo ? '' : 'pixel'}" src="${u.profile_photo || this.cfg.DEFAULT_PFP_DM}" alt="">
            <div style="flex:1">
                <div class="name">${esc(label)}</div>
                <div class="bio">${esc(u.bio || '')}</div>
            </div>
            <div class="act">
                ${mode === 'dm' ? `<button class="btn person-message" type="button">Message</button>` : (mode === 'group-create' || mode === 'group-edit') ? `<input type="checkbox" class="checkbox person-check" ${checked ? 'checked' : ''}>` : ''}
            </div>`;
                if (mode === 'dm') {
                    on(row, 'click', (e) => { if (e.target.closest('.person-message')) return; this.cfg.onStartDm(u); });
                    on(row.querySelector('.person-message'), 'click', (e) => { e.stopPropagation(); this.cfg.onStartDm(u); });
                } else if (mode === 'group-create' || mode === 'group-edit') {
                    const toggle = () => { if (this.state.selectedIds.has(u.id)) this.state.selectedIds.delete(u.id); else this.state.selectedIds.add(u.id); this.renderFriends(this.state.friendsCache); this._refreshSelectedChips(); this._refreshGroupSubmitState(); };
                    on(row, 'click', toggle);
                    on(row.querySelector('.person-check'), 'click', (e) => { e.stopPropagation(); toggle(); });
                }
                this.userList.append(row);
            });
            this._refreshSelectedChips();
        }
        _submit() {
            if (this.state.mode === 'group-create') {
                if (this.state.selectedIds.size < 2) return;
                this.cfg.onCreateGroup([...this.state.selectedIds]);
            } else if (this.state.mode === 'group-edit') {
                const before = new Set(this.state.initialSelectedIds), after = new Set(this.state.selectedIds);
                const add = [...after].filter(x => !before.has(x)), remove = [...before].filter(x => !after.has(x));
                if (!add.length && !remove.length) return;
                this.cfg.onEditGroup({ add, remove });
            }
            this.close();
        }
    }

    /* ====================================
       My Message Color overlay (UI-only)
       ==================================== */
    class MyColorOverlayUI {
        constructor(cfg = {}) {
            this.cfg = Object.assign({
                syncColors: async () => { },
                getColorMap: () => ({}),
                setMyColor: async () => { },
                getContext: () => ({ meId: 0, meName: 'Me', mePhoto: '', isGroup: false }),
                DEFAULT_PFP_DM: ''
            }, cfg);
            this._ensure();
        }
        _ensure() {
            this.root = document.createElement('div');
            this.root.id = 'my-color-overlay';
            this.root.className = 'overlay'; this.root.style.display = 'none';
            this.root.innerHTML = `
            <div class="sheet" style="width:min(460px,94vw)">
                <h3>My Message Color</h3>
                <div class="person" style="cursor:default">
                    <img class="pfp" id="my-color-pfp" src="" alt="">
                        <div style="display:flex;flex-direction:column;gap:6px">
                            <div class="name" id="my-color-name">@me</div>
                            <div class="bio">Change the border color of <b>your</b> messages in this group.</div>
                        </div>
                        <div class="act" style="display:flex;gap:8px;align-items:center">
                            <input class="colorpick" id="my-color-input" type="color" value="#e6e6e6">
                                <button class="btn" id="my-color-clear" type="button" title="Use default">Use default</button>
            </div>
                        </div>
                        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
                            <button class="btn" id="my-color-cancel" type="button">Cancel</button>
                            <button class="btn" id="my-color-save" type="button">Save</button>
                        </div>
        </div>`;
            document.body.append(this.root);
            on(this.root, 'click', e => { if (e.target === this.root) this.hide(); });
            this._name = this.root.querySelector('#my-color-name');
            this._pfp = this.root.querySelector('#my-color-pfp');
            this._input = this.root.querySelector('#my-color-input');
            on(this.root.querySelector('#my-color-clear'), 'click', () => { this._input.value = '#e6e6e6'; });
            on(this.root.querySelector('#my-color-cancel'), 'click', () => this.hide());
            on(this.root.querySelector('#my-color-save'), 'click', async () => {
                const val = String(this._input.value || '').toLowerCase();
                const toSet = (val === '#e6e6e6') ? null : val;
                await this.cfg.setMyColor(toSet); this.hide();
            });
        }
        async show() {
            const ctx = this.cfg.getContext(); if (!ctx.isGroup) return;
            this._name.textContent = ctx.meName || 'Me';
            this._pfp.classList.toggle('pixel', !ctx.mePhoto);
            this._pfp.src = ctx.mePhoto || this.cfg.DEFAULT_PFP_DM;
            await this.cfg.syncColors();
            const map = this.cfg.getColorMap();
            const current = map[ctx.meId] || '#e6e6e6';
            this._input.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#e6e6e6';
            this.root.style.display = 'flex';
        }
        hide() { this.root.style.display = 'none'; }
    }

    /* ===========================
       Chat Menu (3-dots)
       =========================== */
    class ChatMenuUI {
        /**
         * @param {Object} cfg
         * @param {HTMLElement} cfg.menuEl
         * @param {HTMLElement} cfg.buttonEl
         * @param {() => {isGroup:boolean,isOwner:boolean}} cfg.getContext
         * @param {Object<string,Function>} cfg.handlers
         */
        constructor({ menuEl, buttonEl, getContext, handlers = {} } = {}) {
            this.menu = menuEl;
            this.btn = buttonEl;
            this.getContext = getContext || (() => ({ isGroup: false, isOwner: false }));
            this.cfg = { handlers };
            this._wire();
        }
        _wire() {
            if (!this.menu || !this.btn) return;
            on(this.btn, 'click', (e) => { e.stopPropagation(); this.toggle(); });
            // OUTSIDE CLICK: robust contains() check (no class dependency)
            on(document, 'click', (e) => { if (!this.menu.contains(e.target) && !this.btn.contains(e.target)) this.hide(); });
        }
        hide() { if (this.menu) this.menu.style.display = 'none'; }
        toggle() {
            if (!this.menu) return;
            if (this.menu.style.display === 'block') { this.hide(); }
            else { this.render(); this.menu.style.display = 'block'; }
        }
        render() {
            if (!this.menu) return;
            const { isGroup, isOwner } = this.getContext();
            const items = [];
            if (isGroup) {
                if (isOwner) { items.push({ id: 'rename', label: 'Rename group' }); items.push({ id: 'manage', label: 'Manage members' }); }
                else { items.push({ id: 'view-members', label: 'View members' }); }
                items.push({ id: 'chat-settings', label: 'Chat settings' });
                items.push({ id: 'leave', label: 'Leave group' });
                items.push({ id: 'block-group', label: 'Block this group' });
                items.push({ id: 'delete-chat', label: 'Delete chat (for me)' });
            } else {
                items.push({ id: 'chat-settings', label: 'Chat settings' });
                items.push({ id: 'delete-chat', label: 'Delete chat (for me)' });
                items.push({ id: 'block-user', label: 'Block user' });
            }
            this.menu.innerHTML = items.map(i => `<div class="item" data-id="${esc(i.id)}">${esc(i.label)}</div>`).join('');
            by('.item', this.menu).forEach(el => {
                el.onclick = () => {
                    const id = el.dataset.id; this.hide();
                    const h = this.cfg.handlers || {};
                    ({
                        'rename': h.rename,
                        'manage': h.manage,
                        'view-members': h.viewMembers,
                        'chat-settings': h.chatSettings,
                        'leave': h.leave,
                        'block-group': h.blockGroup,
                        'delete-chat': h.deleteChat,
                        'block-user': h.blockUser,
                    }[id] || (() => { }))();
                };
            });
        }
    }

    /* ==================================
       Restyle Group (icon + color)
       ================================== */
    class RestyleGroupUI {
        /**
         * @param {Object} cfg
         * @param {Array<{key:string,val:string}>} cfg.GROUP_COLORS
         * @param {string} cfg.DEFAULT_PFP_GROUP
         * @param {() => { color?:string, photo?:string, isGroup:boolean }} cfg.getMeta
         * @param {(payload:{color?:string, iconBlob?:Blob, useDefaultIcon?:boolean})=>Promise<void>} cfg.onSave
         */
        constructor(cfg = {}) {
            this.cfg = Object.assign({
                GROUP_COLORS: [], DEFAULT_PFP_GROUP: '', getMeta: () => ({ isGroup: false }), onSave: async () => { }
            }, cfg);
            this._ensure();
        }
        _ensure() {
            this.root = document.createElement('div');
            this.root.id = 'restyle-overlay'; this.root.className = 'overlay'; this.root.style.display = 'none';
            this.root.innerHTML = `
                    <div class="sheet" style="width:min(720px,94vw)">
                        <h3>Restyle Group</h3>
                        <div class="pf-preview" style="display:flex;align-items:center;gap:10px">
                            <div class="thumb" style="width:82px;height:82px;border-radius:18px;border:3px solid var(--border,#333);background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden">
                                <img id="restyle-preview" alt="preview">
            </div>
                                <div class="muted">PNG up to <b>512px</b>, ≤ <b>1MB</b>.</div>
                            </div>
                            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 10px">
                                <div style="font-weight:700">Color</div>
                                <div id="restyle-color-choices" style="display:flex;flex-wrap:wrap;gap:8px"></div>
                            </div>
                            <div class="file-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                                <label class="pill"><span>Choose image</span><input id="restyle-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" style="display:none"></label>
                                    <span class="muted">or drag & drop below</span>
                                    <div id="restyle-filename" class="muted" style="font-size:13px"></div>
                                    <button class="btn" id="restyle-clear" type="button">Use default</button>
          </div>
                                <div class="editor" style="margin-top:10px">
                                    <div class="stage" id="restyle-drop" style="border:1px dashed var(--border,#333);border-radius:.6rem;display:inline-block">
                                        <canvas id="restyle-canvas" width="320" height="320"></canvas>
                                    </div>
                                    <div class="controls" style="display:flex;gap:16px;margin-top:8px;align-items:center;flex-wrap:wrap">
                                        <label>Zoom <input id="restyle-zoom" type="range" min="0" max="1" step="0.01" value="0.5"></label>
                                            <label>Rotate <input id="restyle-rot" type="range" min="-180" max="180" step="1" value="0"></label>
                                                <div class="grow" style="flex:1"></div>
                                                <button class="btn secondary" id="restyle-cancel" type="button">Cancel</button>
                                                <button class="btn" id="restyle-save" type="button" disabled>Save</button>
            </div>
                                            <div class="note muted">Tip: drag to reposition.</div>
          </div>
                                    </div>`;
            document.body.append(this.root);
            on(this.root, 'click', (e) => { if (e.target === this.root) this.hide(); });
            // cache
            this.preview = this.root.querySelector('#restyle-preview');
            this.fileIn = this.root.querySelector('#restyle-file');
            this.fileName = this.root.querySelector('#restyle-filename');
            this.clearBtn = this.root.querySelector('#restyle-clear');
            this.saveBtn = this.root.querySelector('#restyle-save');
            this.cancelBtn = this.root.querySelector('#restyle-cancel');
            this.colorBox = this.root.querySelector('#restyle-color-choices');
            this.canvas = this.root.querySelector('#restyle-canvas');
            this.ctx = this.canvas.getContext('2d');
            this.drop = this.root.querySelector('#restyle-drop');
            this.zoomEl = this.root.querySelector('#restyle-zoom');
            this.rotEl = this.root.querySelector('#restyle-rot');
            // interactions
            on(this.clearBtn, 'click', () => this._clearToDefault());
            on(this.cancelBtn, 'click', () => this.hide());
            on(this.fileIn, 'change', () => { const f = this.fileIn.files?.[0]; if (f) this._setImageFile(f); });
            on(this.drop, 'dragover', e => e.preventDefault());
            on(this.drop, 'drop', e => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) this._setImageFile(f); });
            // canvas gestures
            on(this.canvas, 'pointerdown', e => { this._dragging = true; this._last = { x: e.clientX, y: e.clientY }; this.canvas.setPointerCapture(e.pointerId); });
            const end = e => { this._dragging = false; try { this.canvas.releasePointerCapture(e.pointerId); } catch { } };
            on(this.canvas, 'pointerup', end); on(this.canvas, 'pointercancel', end); on(this.canvas, 'pointerleave', end);
            on(this.canvas, 'pointermove', e => { if (!this._dragging) return; const dx = e.clientX - this._last.x, dy = e.clientY - this._last.y; this._last = { x: e.clientX, y: e.clientY }; this._pos.x += dx; this._pos.y += dy; this._redraw(); this._markDirty(); });
            on(this.zoomEl, 'input', () => { this._zoom = parseFloat(this.zoomEl.value); this._redraw(); this._markDirty(); });
            on(this.rotEl, 'input', () => { this._rot = parseFloat(this.rotEl.value) * Math.PI / 180; this._redraw(); this._markDirty(); });
            on(this.saveBtn, 'click', async () => {
                const payload = {};
                if (this._selectedColor && this._selectedColor !== this._initialColor) payload.color = this._selectedColor;
                if (this._imgBitmap) {
                    const { png } = await this._exportPNGMax512();
                    if (png) payload.iconBlob = new Blob([png], { type: 'image/png' });
                } else if (this._clearedToDefault) {
                    payload.useDefaultIcon = true;
                }
                await this.cfg.onSave(payload); this.hide();
            });
        }
        async show() {
            const meta = this.cfg.getMeta(); if (!meta.isGroup) return;
            this._hadCustomIcon = !!meta.photo && meta.photo !== this.cfg.DEFAULT_PFP_GROUP;
            this._clearedToDefault = false; this._imgBitmap = null; this._imgW = 0; this._imgH = 0;
            this._pos = { x: 0, y: 0 }; this._zoom = 0.5; this._rot = 0; this.zoomEl.value = '0.5'; this.rotEl.value = '0';
            this._selectedColor = meta.color || '#ffffff'; this._initialColor = this._selectedColor; this._dirty = false; this.saveBtn.disabled = true;
            // color chips
            this.colorBox.innerHTML = '';
            (this.cfg.GROUP_COLORS || []).forEach(c => {
                const b = document.createElement('button'); b.type = 'button'; b.className = 'btn';
                b.style.cssText = `border-color:${c.val};background:${c.val};color:#000`; b.textContent = c.key;
                if (c.val === this._selectedColor) b.style.outline = '2px solid #fff';
                b.onclick = () => { this._selectedColor = c.val; by('.btn', this.colorBox).forEach(x => x.style.outline = ''); b.style.outline = '2px solid #fff'; this._paintPreview(meta); this._markDirty(); };
                this.colorBox.append(b);
            });
            this._paintPreview(meta);
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.root.style.display = 'flex';
        }
        hide() { this.root.style.display = 'none'; }
        _markDirty() { this._dirty = true; this.saveBtn.disabled = false; }
        _paintPreview(meta) {
            const showDefault = (!this._hadCustomIcon || this._clearedToDefault) && !this._imgBitmap;
            this.preview.onerror = () => { this.preview.src = this.cfg.DEFAULT_PFP_GROUP; };
            this.preview.src = showDefault ? this.cfg.DEFAULT_PFP_GROUP : (meta.photo || this.cfg.DEFAULT_PFP_GROUP);
            const thumb = this.root.querySelector('.pf-preview .thumb');
            thumb.style.borderColor = this._selectedColor; thumb.style.background = showDefault ? this._selectedColor : '#000';
        }
        _scaleForZoom() { const MIN = 0.25, MAX = 6; return MIN + this._zoom * (MAX - MIN); }
        _redraw() {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            if (!this._imgBitmap) return;
            this.ctx.save(); this.ctx.translate(this.canvas.width / 2 + this._pos.x, this.canvas.height / 2 + this._pos.y); this.ctx.rotate(this._rot);
            const s = this._scaleForZoom(), dw = this._imgW * s, dh = this._imgH * s;
            this.ctx.drawImage(this._imgBitmap, -dw / 2, -dh / 2, dw, dh);
            this.ctx.restore();
        }
        _clearToDefault() {
            this._imgBitmap = null; this._imgW = this._imgH = 0; this._pos = { x: 0, y: 0 }; this._zoom = 0.5; this._rot = 0;
            this.zoomEl.value = '0.5'; this.rotEl.value = '0'; this.fileIn.value = ''; this.fileName.textContent = '';
            this._clearedToDefault = true; this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this._paintPreview(this.cfg.getMeta()); this._markDirty();
        }
        async _setImageFile(file) {
            try {
                const bmp = await this._loadBitmap(file); this._imgBitmap = bmp; this._imgW = bmp.width; this._imgH = bmp.height;
                this._pos = { x: 0, y: 0 }; this._zoom = 0.5; this._rot = 0; this.zoomEl.value = '0.5'; this.rotEl.value = '0';
                this.fileName.textContent = file.name; this._clearedToDefault = false; this._redraw();
                const obj = URL.createObjectURL(file); this.preview.src = obj; this.root.querySelector('.pf-preview .thumb').style.background = '#000'; this._markDirty();
            } catch (e) { alert('Could not read image: ' + (e?.message || e)); }
        }
        _loadBitmap(file) {
            return new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = async () => { try { resolve(await createImageBitmap(new Blob([r.result]))); } catch (e) { reject(e); } };
                r.onerror = () => reject(r.error);
                r.readAsArrayBuffer(file);
            });
        }
        async _exportPNGMax512() {
            const BYTES_MAX = 1024 * 1024; let size = 512;
            const renderTo = async (px) => {
                const out = ('OffscreenCanvas' in window) ? new OffscreenCanvas(px, px) : Object.assign(document.createElement('canvas'), { width: px, height: px });
                const octx = out.getContext('2d'); octx.clearRect(0, 0, px, px);
                if (this._imgBitmap) {
                    const s = this._scaleForZoom(); octx.save();
                    octx.translate(px / 2 + (this._pos.x * (px / this.canvas.width)), px / 2 + (this._pos.y * (px / this.canvas.height)));
                    octx.rotate(this._rot);
                    const dw = this._imgW * s * (px / this.canvas.width), dh = this._imgH * s * (px / this.canvas.height);
                    octx.drawImage(this._imgBitmap, -dw / 2, -dh / 2, dw, dh); octx.restore();
                }
                const blob = out.convertToBlob ? await out.convertToBlob({ type: 'image/png' }) : await new Promise(res => out.toBlob(res, 'image/png'));
                return new Uint8Array(await blob.arrayBuffer());
            };
            let png = this._imgBitmap ? await renderTo(size) : null;
            while (png && png.length > BYTES_MAX && size > 192) { size = Math.floor(size * 0.85); png = await renderTo(size); }
            if (png && png.length > BYTES_MAX) throw new Error('Icon too large even after resizing');
            return { png, size };
        }
    }

    /* ==================================
   Chat Settings (tabs + search)
   ================================== */
    class ChatSettingsUI {
        constructor({
            GROUP_COLORS = [],
            DEFAULT_PFP_GROUP = '',
            getContext = () => ({ isGroup: false, convId: 0, meta: {}, det: {} }),
            onSaveStyle = async () => { },
            onSaveReactions = async () => { },
            onSaveDeletion = async () => { },
        } = {}) {
            this.cfg = { GROUP_COLORS, DEFAULT_PFP_GROUP, getContext, onSaveStyle, onSaveReactions, onSaveDeletion };
            this._uid = Math.random().toString(36).slice(2);
            this._ensure();
        }

        _installStyles() {
            if (document.getElementById('cs-ui-base-styles')) return;
            const st = document.createElement('style');
            st.id = 'cs-ui-base-styles';
            st.textContent = `
#chat-settings-overlay{position:fixed;inset:0;display:none;background:rgba(0,0,0,.18);z-index:2000;align-items:center;justify-content:center}
#chat-settings-overlay .sheet{background:var(--bg,#111);color:var(--fg,#eee);border:1px solid var(--border,#333);border-radius:.8rem;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:10px}
.cs{padding:0}
.cs-left{min-width:210px;border-right:1px solid var(--border,#333);padding:12px;display:flex;flex-direction:column;gap:8px}
.cs-search{padding:.45rem .6rem;border:1px solid var(--border,#333);background:var(--bg-2,#181818);color:inherit;border-radius:.5rem}
.cs-tabs{display:flex;flex-direction:column;gap:6px}
.cs-tab{justify-content:flex-start}
.cs-tab.active{outline:2px solid var(--accent,#6cf)}
.cs-right{flex:1;min-width:0;padding:12px;display:flex;flex-direction:column;gap:10px}
.cs-right-head{display:flex;align-items:center;justify-content:space-between}
.cs-content{overflow:auto;display:flex;flex-direction:column;gap:12px;max-height:calc(92vh - 140px)} /* room for footer */
.cs-footer{display:flex;gap:8px;justify-content:flex-end;padding:10px;border-top:1px solid var(--border,#333);position:sticky;bottom:0;background:var(--bg,#111)}
.cs-group{border:1px solid var(--border,#333);border-radius:.6rem;padding:10px}
.cs-group>.title{font-weight:700;margin-bottom:8px;opacity:.9}
.cs-row{display:flex;gap:12px;align-items:flex-start;padding:8px;border:1px solid var(--border,#333);border-radius:.5rem;background:var(--bg-2,#181818)}
.cs-row+.cs-row{margin-top:8px}
.lbl{min-width:160px;max-width:220px}
.lbl .name{font-weight:600}
.lbl .desc{opacity:.8;font-size:.9em;margin-top:2px}
.ctl{flex:1;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{border:1px solid var(--border,#333);background:var(--bg-2,#181818);color:inherit;border-radius:.45rem;padding:.35rem .6rem;cursor:pointer}
.btn.secondary{opacity:.9}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.pill{border:1px solid var(--border,#333);background:var(--bg-2,#181818);border-radius:999px;padding:.25rem .6rem;cursor:pointer}
.chip{border:1px solid var(--border,#333);background:var(--bg-2,#181818);border-radius:999px;padding:.25rem .6rem;cursor:pointer}
.chip.active{outline:2px solid #fff}
.select,.input{padding:.35rem .5rem;border:1px solid var(--border,#333);background:var(--bg-2,#181818);color:inherit;border-radius:.35rem;cursor:pointer}
.thumb{width:64px;height:64px;border-radius:14px;border:3px solid var(--border,#333);background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}
.thumb img{max-width:100%;max-height:100%}
.cs-hide{display:none!important}

/* inputs always clickable */
#chat-settings-overlay input,
#chat-settings-overlay select,
#chat-settings-overlay button {
  pointer-events: auto !important;
  position: relative;
  z-index: 1;
}

/* label hit area */
#chat-settings-overlay label {
  display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;
}

/* checkbox styling */
#chat-settings-overlay input[type="checkbox"]{
  -webkit-appearance: none; appearance: none; width: 20px; height: 20px;
  border: 2px solid rgba(255,255,255,.95); border-radius: 4px; background: transparent;
  display: inline-block; vertical-align: middle; cursor: pointer;
  transition: background .12s ease, border-color .12s ease, box-shadow .12s ease; box-sizing: border-box;
}
#chat-settings-overlay input[type="checkbox"]:checked{ background:#fff; border-color:#fff; }
#chat-settings-overlay input[type="checkbox"]:focus-visible{ outline:2px solid var(--accent,#6cf); outline-offset:2px; }
#chat-settings-overlay input[type="checkbox"][disabled]{ opacity:.55; cursor:not-allowed; }

/* radios keep native look */
#chat-settings-overlay input[type="radio"]{ -webkit-appearance:auto; appearance:auto; width:18px; height:18px; cursor:pointer; }

/* 🔽 visibly greyed out selects when disabled */
#chat-settings-overlay select:disabled,
#chat-settings-overlay .select:disabled {
  opacity:.55; filter:grayscale(1);
  pointer-events: none !important;
}

/* confirm dialog sizing */
#cs-confirm .sheet { max-width: 520px; }
    `;
            document.head.appendChild(st);
        }

        _ensure() {
            this._installStyles();

            this.root = document.createElement('div');
            this.root.id = 'chat-settings-overlay';
            this.root.style.display = 'none';
            this.root.innerHTML = `
      <div class="sheet cs" style="width:min(880px,96vw);max-height:92vh;display:flex;flex-direction:row">
        <aside class="cs-left">
          <input class="cs-search" type="text" placeholder="Search settings…" data-role="search" />
          <div class="cs-tabs" data-role="tabs">
            <button class="btn cs-tab" data-tab="style">Style</button>
            <button class="btn cs-tab" data-tab="deletion">Deletion</button>
            <button class="btn cs-tab" data-tab="reactions">Reactions</button>
          </div>
        </aside>
        <main class="cs-right">
          <div class="cs-right-head">
            <h3>Chat settings</h3>
          </div>
          <div class="cs-content" data-role="content"></div>
          <div class="cs-footer">
            <button class="btn secondary" data-action="close" type="button">Close</button>
            <button class="btn" data-action="save-all" type="button" disabled>Save</button>
          </div>
        </main>
      </div>`;
            document.body.appendChild(this.root);

            // confirm overlay (discard changes)
            this.confirm = document.createElement('div');
            this.confirm.id = 'cs-confirm';
            this.confirm.className = 'overlay';
            this.confirm.style.display = 'none';
            this.confirm.innerHTML = `
      <div class="sheet" style="width:min(460px,90vw)">
        <h3>Discard changes?</h3>
        <div class="muted" style="margin-top:6px">You have unsaved changes.</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button class="btn secondary" data-confirm="cancel" type="button">Cancel</button>
          <button class="btn" data-confirm="discard" type="button">Discard</button>
        </div>
      </div>`;
            document.body.appendChild(this.confirm);

            this.q = this.root.querySelector('[data-role="search"]');
            this.tabs = this.root.querySelector('[data-role="tabs"]');
            this.content = this.root.querySelector('[data-role="content"]');

            // backdrop click -> maybe close
            this.root.addEventListener('click', (e) => {
                if (e.target === this.root) this._maybeClose();
            });

            // Close / Save buttons (footer)
            this.root.addEventListener('click', (e) => {
                const act = e.target.closest('[data-action]')?.dataset.action;
                if (!act) return;
                if (act === 'close') this._maybeClose();
                else if (act === 'save-all') this._saveAll();
            });

            // Confirm overlay handlers
            this.confirm.addEventListener('click', (e) => {
                if (e.target === this.confirm) return this._hideConfirm();
                const btn = e.target.closest('[data-confirm]');
                if (!btn) return;
                const act = btn.dataset.confirm;
                if (act === 'cancel') this._hideConfirm();
                if (act === 'discard') { this._hideConfirm(); this._reallyClose(); }
            });

            // ESC closes (with confirm if dirty)
            window.addEventListener('keydown', (e) => {
                if (this.root.style.display === 'none') return;
                if (e.key === 'Escape') { e.preventDefault(); this._maybeClose(); }
            });

            this.tabs.addEventListener('click', (e) => {
                const b = e.target.closest('.cs-tab'); if (!b) return;
                this.activeTab = b.dataset.tab || 'style';
                this.q.value = '';
                this._render();
            });

            this.q.addEventListener('input', () => this._render());

            // Delegated: form changes
            this.content.addEventListener('change', (e) => {
                const t = e.target;

                if (t.matches('[data-setting="rx-enabled"]')) {
                    this.state.reactions.enabled = t.checked;
                    this._render(); // re-render to flip disabled states
                } else if (t.matches('[data-setting="rx-mode"]')) {
                    this.state.reactions.mode = t.value;
                } else if (t.matches('[data-setting="del-enabled"]')) {
                    this.state.deletion.enabled = t.checked;
                    this._render();
                } else if (t.matches('[data-setting="del-window"]')) {
                    const v = t.value;
                    if (v === 'null') this.state.deletion.windowSec = null;
                    else if (v === 'custom') this.state.deletion.windowSec = this.state.deletion.windowSec ?? 120;
                    else this.state.deletion.windowSec = parseInt(v, 10);
                    this._render();
                } else if (t.matches('[data-setting="del-custom"]')) {
                    const n = Math.max(1, parseInt(t.value || '0', 10));
                    this.state.deletion.windowSec = Number.isFinite(n) ? n : 120;
                } else if (t.matches('[data-setting="style-file"]')) {
                    const f = t.files && t.files[0];
                    if (f) {
                        this._pendingIconFile = f;
                        this._useDefaultIcon = false;
                        const url = URL.createObjectURL(f);
                        const img = this.content.querySelector('[data-ref="style-img"]');
                        const ring = this.content.querySelector('[data-ref="style-thumb"]');
                        if (img) { img.src = url; img.dataset.default = '0'; }
                        if (ring) ring.style.background = '#000';
                    }
                }
                this._updateFooterButtons();
            });

            // Delegated: explicit toggles
            this.content.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action]');
                if (btn) {
                    const act = btn.dataset.action;
                    if (act === 'style-color') {
                        const val = btn.dataset.value;
                        this.state.style.color = val;
                        this.content.querySelectorAll('[data-action="style-color"]')
                            .forEach(x => x.classList.toggle('active', x.dataset.value === val));
                        const ring = this.content.querySelector('[data-ref="style-thumb"]');
                        const img = this.content.querySelector('[data-ref="style-img"]');
                        if (ring) {
                            ring.style.borderColor = val;
                            ring.style.background = (img?.dataset.default === '1') ? val : '#000';
                        }
                        this._updateFooterButtons();
                    } else if (act === 'style-use-default') {
                        this._pendingIconFile = null;
                        this._useDefaultIcon = true;
                        const img = this.content.querySelector('[data-ref="style-img"]');
                        const ring = this.content.querySelector('[data-ref="style-thumb"]');
                        if (img) { img.src = this.cfg.DEFAULT_PFP_GROUP; img.dataset.default = '1'; }
                        if (ring) ring.style.background = this.state.style.color;
                        this._updateFooterButtons();
                    }
                    return;
                }

                // wrapper toggles (only when NOT clicking the actual input)
                const rxWrap = e.target.closest('[data-toggle="rx-enabled"]');
                if (rxWrap) {
                    if (e.target.closest('input[type="checkbox"]')) return;
                    e.preventDefault();
                    const inp = rxWrap.querySelector('[data-setting="rx-enabled"]');
                    if (inp) { inp.checked = !inp.checked; inp.dispatchEvent(new Event('change', { bubbles: true })); }
                    return;
                }

                const delWrap = e.target.closest('[data-toggle="del-enabled"]');
                if (delWrap) {
                    if (e.target.closest('input[type="checkbox"]')) return;
                    e.preventDefault();
                    const inp = delWrap.querySelector('[data-setting="del-enabled"]');
                    if (inp) { inp.checked = !inp.checked; inp.dispatchEvent(new Event('change', { bubbles: true })); }
                    return;
                }
            });

            this.activeTab = 'style';
        }

        async show(tab = 'style') {
            this.activeTab = tab;
            const ctx = this.cfg.getContext() || {};
            const meta = ctx.meta || {};
            const det = ctx.det || {};
            this._isGroup = !!ctx.isGroup;

            this.state = {
                style: {
                    color: meta.color || '#ffffff',
                    photo: meta.photo || this.cfg.DEFAULT_PFP_GROUP
                },
                reactions: {
                    enabled: !!(meta.reactions_enabled ?? det.reactions_enabled),
                    mode: (meta.reactions_mode || det.reactions_mode || 'both')
                },
                deletion: {
                    enabled: !!(meta.message_delete_enabled ?? det.message_delete_enabled),
                    windowSec: (meta.message_delete_window_sec ?? det.message_delete_window_sec ?? null)
                }
            };
            this._pendingIconFile = null;
            this._useDefaultIcon = false;

            this._setInitialFromState();
            this.q.value = '';
            this.root.style.display = 'flex';
            this._render();
            this._updateFooterButtons();
        }

        hide() { this.root.style.display = 'none'; }
        _showConfirm() { this.confirm.style.display = 'flex'; }
        _hideConfirm() { this.confirm.style.display = 'none'; }
        _maybeClose() { this._computeDirty() ? this._showConfirm() : this._reallyClose(); }
        _reallyClose() { this.hide(); }

        _setInitialFromState() {
            this._initial = JSON.parse(JSON.stringify(this.state));
            this._initialUseDefaultIcon = false;
            this._initialPendingIcon = null;
            this._dirty = false;
        }

        _isStyleDirty() {
            const colorChanged = this.state.style.color !== this._initial.style.color;
            const iconChange = !!this._pendingIconFile || (!!this._useDefaultIcon && !this._initialUseDefaultIcon);
            return colorChanged || iconChange;
        }
        _isRxDirty() {
            return this.state.reactions.enabled !== this._initial.reactions.enabled
                || this.state.reactions.mode !== this._initial.reactions.mode;
        }
        _isDelDirty() {
            return this.state.deletion.enabled !== this._initial.deletion.enabled
                || (this.state.deletion.enabled && this.state.deletion.windowSec !== this._initial.deletion.windowSec)
                || (!this.state.deletion.enabled && this._initial.deletion.enabled);
        }
        _computeDirty() {
            this._dirty = this._isStyleDirty() || this._isRxDirty() || this._isDelDirty();
            return this._dirty;
        }
        _updateFooterButtons() {
            const saveBtn = this.root.querySelector('[data-action="save-all"]');
            if (saveBtn) saveBtn.disabled = !this._computeDirty();
        }

        async _saveAll() {
            if (!this._computeDirty()) return;
            const ops = [];

            if (this._isStyleDirty()) {
                const payload = {};
                if (this.state.style.color !== this._initial.style.color) payload.color = this.state.style.color;
                if (this._pendingIconFile) payload.iconBlob = this._pendingIconFile;
                if (this._useDefaultIcon) payload.useDefaultIcon = true;
                ops.push(this.cfg.onSaveStyle(payload));
            }

            if (this._isRxDirty()) {
                const { enabled, mode } = this.state.reactions;
                ops.push(this.cfg.onSaveReactions({ enabled, mode }));
            }

            if (this._isDelDirty()) {
                const { enabled, windowSec } = this.state.deletion;
                ops.push(this.cfg.onSaveDeletion({ enabled, windowSec: enabled ? windowSec : null }));
            }

            try {
                const btn = this.root.querySelector('[data-action="save-all"]');
                if (btn) btn.disabled = true;
                await Promise.all(ops);
                // reset dirty baseline
                this._pendingIconFile = null;
                this._useDefaultIcon = false;
                this._setInitialFromState();
            } finally {
                this._updateFooterButtons();
            }
        }

        _render() {
            const q = (this.q.value || '').trim().toLowerCase();

            this.tabs.querySelectorAll('.cs-tab').forEach(b => {
                const cat = b.dataset.tab;
                b.classList.toggle('active', cat === this.activeTab);
                if (cat === 'style' && !this._isGroup) b.classList.add('cs-hide');
                else if (!(cat === 'style' && !this._isGroup)) b.classList.remove('cs-hide');
            });

            const groups = {
                style: this._isGroup ? this._groupStyle() : null,
                deletion: this._groupDeletion(),
                reactions: this._groupReactions(),
            };

            this.content.innerHTML = '';

            if (!q) {
                const g = groups[this.activeTab];
                if (g) this.content.appendChild(g);
                this._updateFooterButtons();
                return;
            }

            const leftShown = new Set();
            ['style', 'deletion', 'reactions'].forEach(cat => {
                const g = groups[cat]; if (!g) return;
                const rows = Array.from(g.querySelectorAll('.cs-row'));
                let has = false;
                rows.forEach(r => {
                    const text = (r.textContent || '').toLowerCase();
                    const kw = (r.getAttribute('data-keywords') || '').toLowerCase();
                    if (text.includes(q) || kw.includes(q)) has = true; else r.remove();
                });
                if (has) { leftShown.add(cat); this.content.appendChild(g); }
            });

            this.tabs.querySelectorAll('.cs-tab').forEach(b => {
                const cat = b.dataset.tab;
                if (cat === 'style' && !this._isGroup) { b.classList.add('cs-hide'); return; }
                b.classList.toggle('cs-hide', !leftShown.has(cat));
            });

            this._updateFooterButtons();
        }

        _groupStyle() {
            const g = document.createElement('div'); g.className = 'cs-group';
            g.innerHTML = `<div class="title">Style</div>`;

            // Color
            const rowC = document.createElement('div');
            rowC.className = 'cs-row'; rowC.setAttribute('data-keywords', 'style color theme');
            rowC.innerHTML = `
      <div class="lbl">
        <div class="name">Group color</div>
        <div class="desc">Accent used for the avatar ring and theming.</div>
      </div>
      <div class="ctl" data-ref="color-chips"></div>`;
            const chips = rowC.querySelector('[data-ref="color-chips"]');
            const palette = this.cfg.GROUP_COLORS.length ? this.cfg.GROUP_COLORS
                : [{ key: 'A', val: '#6cf' }, { key: 'B', val: '#f66' }, { key: 'C', val: '#9f6' }, { key: 'D', val: '#fc6' }, { key: 'E', val: '#a9f' }];
            palette.forEach(c => {
                const b = document.createElement('button'); b.type = 'button'; b.className = 'chip';
                b.style.cssText = `border-color:${c.val};background:${c.val};color:#000`;
                b.textContent = c.key;
                b.dataset.action = 'style-color'; b.dataset.value = c.val;
                if (c.val === this.state.style.color) b.classList.add('active');
                chips.appendChild(b);
            });

            // Icon
            const rowI = document.createElement('div');
            rowI.className = 'cs-row'; rowI.setAttribute('data-keywords', 'icon avatar image upload picture');
            rowI.innerHTML = `
      <div class="lbl">
        <div class="name">Group icon</div>
        <div class="desc">Upload a PNG/JPG/WebP (optional).</div>
      </div>
      <div class="ctl">
        <div class="thumb" data-ref="style-thumb"><img data-ref="style-img" alt=""></div>
        <label class="pill">
          <span>Choose image</span>
          <input data-setting="style-file" type="file" accept="image/png,image/jpeg,image/webp" style="display:none">
        </label>
        <button class="btn" data-action="style-use-default" type="button">Use default</button>
      </div>`;
            const ring = rowI.querySelector('[data-ref="style-thumb"]');
            const img = rowI.querySelector('[data-ref="style-img"]');
            ring.style.borderColor = this.state.style.color;
            img.src = this.state.style.photo || this.cfg.DEFAULT_PFP_GROUP;
            const isDefault = !this.state.style.photo || this.state.style.photo === this.cfg.DEFAULT_PFP_GROUP;
            img.dataset.default = isDefault ? '1' : '0';
            ring.style.background = isDefault ? this.state.style.color : '#000';

            g.append(rowC, rowI);
            return g;
        }

        _groupReactions() {
            const g = document.createElement('div'); g.className = 'cs-group';
            g.innerHTML = `<div class="title">Reactions</div>`;

            const row = document.createElement('div');
            row.className = 'cs-row';
            row.setAttribute('data-keywords', 'reactions emoji custom allowed enable disable mode');

            const enabled = !!this.state.reactions.enabled;
            const rawMode = this.state.reactions.mode || 'both';
            const mode = (rawMode === 'none') ? 'both' : rawMode; // display default when disabled

            row.innerHTML = `
      <div class="lbl">
        <div class="name">Reactions</div>
        <div class="desc">Enable reactions and choose what kinds are allowed.</div>
      </div>
      <div class="ctl">
        <label data-toggle="rx-enabled">
          <input data-setting="rx-enabled" type="checkbox" ${enabled ? 'checked' : ''}>
          Enable
        </label>

        <label style="display:flex;align-items:center;gap:8px;">
          Type
          <select class="select" data-setting="rx-mode" ${enabled ? '' : 'disabled'}>
            <option value="both"  ${mode === 'both' ? 'selected' : ''}>Emoji + Custom</option>
            <option value="emoji" ${mode === 'emoji' ? 'selected' : ''}>Emoji only</option>
            <option value="custom" ${mode === 'custom' ? 'selected' : ''}>Custom only</option>
          </select>
        </label>
      </div>`;
            g.appendChild(row);
            return g;
        }

        _groupDeletion() {
            const g = document.createElement('div'); g.className = 'cs-group';
            g.innerHTML = `<div class="title">Deletion</div>`;
            const row = document.createElement('div'); row.className = 'cs-row'; row.setAttribute('data-keywords', 'deletion delete window time seconds minutes hours');

            const en = !!this.state.deletion.enabled;
            const ws = this.state.deletion.windowSec;
            const value =
                ws == null ? 'null'
                    : ['30', '60', '300', '3600', '86400'].includes(String(ws)) ? String(ws)
                        : 'custom';

            row.innerHTML = `
      <div class="lbl">
        <div class="name">Message deletion</div>
        <div class="desc">Allow members to delete sent messages for a limited time.</div>
      </div>
      <div class="ctl">
        <label data-toggle="del-enabled"><input data-setting="del-enabled" type="checkbox" ${en ? 'checked' : ''}> Allow deletion</label>
        <select data-setting="del-window" class="select" ${en ? '' : 'disabled'}>
          <option value="30" ${value === '30' ? 'selected' : ''}>30 seconds</option>
          <option value="60" ${value === '60' ? 'selected' : ''}>1 minute</option>
          <option value="300" ${value === '300' ? 'selected' : ''}>5 minutes</option>
          <option value="3600" ${value === '3600' ? 'selected' : ''}>1 hour</option>
          <option value="86400" ${value === '86400' ? 'selected' : ''}>24 hours</option>
          <option value="custom" ${value === 'custom' ? 'selected' : ''}>Custom…</option>
          <option value="null" ${value === 'null' ? 'selected' : ''}>No limit</option>
        </select>
        <label ${en && value === 'custom' ? '' : 'class="cs-hide"'} data-ref="del-custom-wrap">
          Seconds: <input data-setting="del-custom" class="input" type="number" min="1" step="1" value="${(Number.isFinite(ws) ? ws : 120)}">
        </label>
      </div>`;
            if (!en) row.querySelector('[data-ref="del-custom-wrap"]').classList.add('cs-hide');

            g.appendChild(row);
            return g;
        }
    }

    /* ==========================================
       Basic composer / controls wiring (UI-only)
       ========================================== */
    function wireBasicChatControls({
        onAttachClick = () => $id('file')?.click(),
        onFilesChosen = async () => { },
        onSend = () => { },
        onStartRecording = () => { },
        onStopRecording = () => { },
        isRecording = () => false,
    } = {}) {
        on($id('btn-attach'), 'click', onAttachClick);
        const fileEl = $id('file');
        if (fileEl) fileEl.onchange = async (e) => {
            const files = Array.from(e.target.files || []);
            if (files.length) await onFilesChosen(files);
            e.target.value = '';
        };
        on($id('btn-send'), 'click', onSend);
        on($id('text'), 'keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } });
        const v = $id('btn-voice'); if (v) {
            const start = (e) => { e.preventDefault(); v.textContent = 'Recording… release to stop'; onStartRecording(); };
            const stop = (e) => { e.preventDefault(); v.textContent = 'Hold to record'; onStopRecording(); };
            on(v, 'pointerdown', start); on(v, 'pointerup', stop); on(v, 'pointercancel', stop);
            on(v, 'mouseleave', () => { if (isRecording()) stop(new Event('pointerup')); });
        }
    }

    /* ========== Export & bootstrap ========== */
    const api = { FriendPickerUI, MyColorOverlayUI, ChatMenuUI, RestyleGroupUI, ChatSettingsUI, wireBasicChatControls };
    if (typeof module === 'object' && module.exports) module.exports = api;
    global.UIOverlays = Object.assign({}, global.UIOverlays || {}, api);

    (function bootstrap() {
        const MA = (global.MessagesApp ||= {});
        function init() {
            const MenuCls = global.UIOverlays && global.UIOverlays.ChatMenuUI;
            const SettingsCls = global.UIOverlays && global.UIOverlays.ChatSettingsUI;
            const menuEl = document.getElementById('chat-menu');
            const btnEl = document.getElementById('chat-menu-btn');
            if (!MenuCls || !SettingsCls || !menuEl || !btnEl) return;

            if (!MA._chatMenuUI) {
                MA._chatMenuUI = new MenuCls({
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

            if (!MA.chatSettingsOverlay) {
                const GROUP_COLORS = MA.GROUP_COLORS || [];
                const DEFAULT_PFP_GROUP = MA.DEFAULT_PFP_GROUP || '/web/default-groupavatar.png';
                const apiCall = MA.api && MA.api.api;

                // inside bootstrap() after:  const apiCall = MA.api && MA.api.api;
                if (apiCall && !MA._apiWrapped) {
                    const orig = apiCall;

                    // simple cache/dedupe with exponential backoff for the library endpoint
                    let _libCache = null;
                    let _libInflight = null;
                    let _libLastFailAt = 0;
                    let _libBackoffMs = 0;

                    async function getCustomLibrary(opts = {}) {
                        // if we already have data, return it
                        if (_libCache) return _libCache;

                        // if a request is already running, piggyback
                        if (_libInflight) return _libInflight;

                        // backoff if we recently failed
                        const now = Date.now();
                        const since = now - _libLastFailAt;
                        if (_libLastFailAt && since < _libBackoffMs) {
                            // during backoff, do not hammer the server; return whatever we have (maybe null)
                            return _libCache || [];
                        }

                        _libInflight = (async () => {
                            try {
                                const resp = await orig('/dm/reactions/custom/library', { method: 'GET' });
                                const items = Array.isArray(resp?.items) ? resp.items : (resp?.items || []);
                                _libCache = items;
                                _libLastFailAt = 0;
                                _libBackoffMs = 0;
                                return _libCache;
                            } catch (e) {
                                console.warn('[rx-lib] fetch failed', e?.message || e);
                                _libLastFailAt = Date.now();
                                _libBackoffMs = Math.min(300000, _libBackoffMs ? _libBackoffMs * 2 : 5000); // cap at 5 min
                                return _libCache || []; // degrade to empty
                            } finally {
                                _libInflight = null;
                            }
                        })();

                        return _libInflight;
                    }

                    MA.api.api = async (url, opts = {}) => {
                        const method = (opts.method || 'GET').toUpperCase();
                        let showBody = opts.body;
                        try { if (showBody instanceof FormData) showBody = Array.from(showBody.entries()); } catch { }

                        if (opts.body && !(opts.body instanceof FormData)) {
                            if (typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
                            opts.headers = Object.assign({}, opts.headers, {
                                'Content-Type': 'application/json; charset=UTF-8',
                                'Accept': 'application/json'
                            });
                        }

                        const isRx = /\/dm\/messages\/\d+\/reactions\/toggle$/.test(String(url));
                        console.debug('[api->]', method, url, {
                            headers: opts.headers,
                            body: showBody
                        });

                        try {
                            // library dedupe preserved
                            if (String(url).endsWith('/dm/reactions/custom/library')) {
                                const data = await getCustomLibrary(opts);
                                console.debug('[api<-]', method, url, { items: (data || []).length });
                                return { ok: true, items: data };
                            }

                            const resp = await orig(url, opts);

                            // log type + a small preview if it's a string
                            const logObj = (typeof resp === 'string')
                                ? { type: 'string', preview: resp.slice(0, 400) }
                                : { type: typeof resp, keys: resp && typeof resp === 'object' ? Object.keys(resp) : null };

                            if (isRx) console.debug('[api<-][rx]', method, url, logObj);
                            else console.debug('[api<-]', method, url, logObj);

                            return resp;
                        } catch (e) {
                            // try to surface as much as possible
                            const info = {
                                message: e?.message,
                                name: e?.name,
                                detail: e?.detail,
                                stack: e?.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : undefined
                            };
                            console.error('[api x]', method, url, info);
                            throw e;
                        }
                    };

                    // Expose a way to refresh after uploads/bookmarks, without thundering herds
                    MA.refreshCustomReactionsLibrary = async () => {
                        _libCache = null;
                        _libLastFailAt = 0;
                        _libBackoffMs = 0;
                        try { await getCustomLibrary(); } catch { }
                    };

                    MA._apiWrapped = true;
                }

                // Put this once near your other helpers:
                function unwrapSettings(resp) {
                    // Some routes return { ok, settings:{...} }, others return settings directly.
                    if (resp && typeof resp === 'object' && resp.settings && typeof resp.settings === 'object') {
                        return resp.settings;
                    }
                    return resp || {};
                }

                // Pull from server and cache into s.convMeta in the shape ChatSettingsUI expects
                // 🔁 replace the current MA.syncConvSettings with this version
                MA.syncConvSettings = async (cid) => {
                    const apiCall = MA.api && MA.api.api;
                    try {
                        console.debug('[ui][sync settings][start]', { cid });
                        const raw = await apiCall(`/dm/conversations/${cid}/settings`, { method: 'GET' });

                        // unwrap { ok, settings } variants
                        const sdata = (raw && raw.settings && typeof raw.settings === 'object') ? raw.settings : (raw || {});

                        const asBoolOrNull = (v) => {
                            if (v === undefined || v === null || v === 'undefined' || v === 'null') return null;
                            return (v === true || v === 1 || String(v).toLowerCase() === '1' || String(v).toLowerCase() === 'true');
                        };
                        const asIntOrNull = v => (v == null || v === 'null' || v === '') ? null : (Number(v) | 0);
                        const toTs = v => { if (!v) return null; const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };

                        console.debug('[ui][sync settings][raw-response]', { cid, raw });
                        console.debug('[ui][sync settings][normalized-sdata]', { cid, sdata });

                        const meta = {};

                        // reactions
                        const rxEnabledRaw = (sdata.reactable ?? sdata.reactions_enabled);
                        const rxModeRaw = (sdata.reaction_mode ?? sdata.reactions_mode);
                        const rxEffRaw = (sdata.reactions_effective_from ?? sdata.reactions_effective_from_ts);

                        meta.reactions_enabled = asBoolOrNull(rxEnabledRaw);                  // null when unknown
                        meta.reactions_mode = (rxModeRaw || 'both');                       // UI default
                        meta.reactions_effective_from_ts = toTs(rxEffRaw);

                        // deletion
                        const delEnabledRaw = (sdata.allow_delete ?? sdata.message_delete_enabled);
                        const delWinRaw = (sdata.delete_window_sec ?? sdata.message_delete_window_sec);
                        const delEffRaw = (sdata.delete_effective_from ?? sdata.delete_effective_from_ts);

                        meta.message_delete_enabled = asBoolOrNull(delEnabledRaw);                 // null when unknown
                        meta.message_delete_window_sec = (meta.message_delete_enabled === true) ? asIntOrNull(delWinRaw) : null;
                        meta.delete_effective_from_ts = toTs(delEffRaw);

                        if (!meta.delete_effective_from_ts && meta.message_delete_enabled) {
                            console.warn('[ui][sync settings] delete enabled BUT missing delete_effective_from → UI will deny deletes', { cid, sdata, meta });
                        }
                        if (!meta.reactions_effective_from_ts && meta.reactions_enabled) {
                            console.warn('[ui][sync settings] reactions enabled BUT missing reactions_effective_from', { cid, sdata, meta });
                        }

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

                        MA.refreshMessageActions?.();

                        console.debug('[ui][sync settings][ok]', {
                            cid,
                            stored_meta_prev: prev,
                            stored_meta_next: next
                        });
                    } catch (e) {
                        console.warn('[ui][sync settings][error]', { cid, error: e?.message || e, stack: e?.stack });
                    } finally {
                        MA.refreshMessageActions?.();
                    }
                };

                MA.chatSettingsOverlay = new SettingsCls({
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
                            await apiCall(`/dm/conversations/${cid}/appearance`, {
                                method: 'PATCH',
                                body: fd
                            });
                        } catch (e) {
                            alert(e?.message || e);
                        }
                        MA.renderChatMenu?.();
                    },

                    onSaveReactions: async ({ enabled, mode }) => {
                        const cid = (MA.state?.convId) | 0;
                        const body = {
                            reactable: !!enabled,
                            reaction_mode: enabled ? (mode || 'both') : 'none'
                        };
                        console.debug('[ui][save reactions]', { cid, body });
                        try {
                            await MA.api.api(`/dm/conversations/${cid}/settings`, { method: 'PATCH', body });
                            console.debug('[ui][save reactions][ok]');
                            await MA.syncConvSettings(cid); // pull back the stamped effective_from, etc.
                        } catch (e) {
                            console.error('[ui][save reactions][error]', e);
                        }
                        MA.renderChatMenu?.();
                    },

                    onSaveDeletion: async ({ enabled, windowSec }) => {
                        const cid = (MA.state?.convId) | 0;
                        const body = { allow_delete: !!enabled };
                        if (enabled) body.delete_window_sec = (windowSec == null ? 'null' : (windowSec | 0));
                        console.debug('[ui][save deletion]', { cid, body });
                        try {
                            await apiCall(`/dm/conversations/${cid}/settings`, { method: 'PATCH', body });
                            console.debug('[ui][save deletion][ok]');
                            await MA.syncConvSettings(cid);
                        } catch (e) { console.error('[ui][save deletion][error]', e); }
                        MA.renderChatMenu?.();
                    }
                });
            }

            // handlers + helpers
            MA._chatMenuHandlers = Object.assign({}, MA._chatMenuHandlers, {
                chatSettings: async () => {
                    const cid = (MA.state?.convId) | 0;
                    await MA.syncConvSettings(cid);
                    MA.chatSettingsOverlay?.show?.('style');
                }
            });
            MA.setChatMenuHandlers = (h) => { MA._chatMenuUI.cfg.handlers = h || {}; MA._chatMenuUI.render(); };
            MA.renderChatMenu = () => MA._chatMenuUI.render();
            MA.setChatMenuHandlers(MA._chatMenuHandlers);
            MA.renderChatMenu();
        }

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
        else init();
    })();

    (function ensureDeleteHandler() {
        const MA = (window.MessagesApp ||= {});
        if (typeof MA.onDeleteForAll === 'function') return;

        MA.onDeleteForAll = async (msgEl) => {
            const api = MA.api?.api || (async () => { throw new Error('api missing'); });
            const { id } = window.MessagesApp.extractMsgMeta(msgEl);
            if (!id) { console.warn('[del] no message id on element', msgEl); return; }

            console.debug('[del] attempt', { id });

            // Try a few common endpoints; log each attempt
            const endpoints = [
                { method: 'POST', url: `/dm/messages/${id}/delete` },
                { method: 'POST', url: `/dm/messages/${id}/delete_for_all` },
                { method: 'DELETE', url: `/dm/messages/${id}` }
            ];

            let lastErr = null, okResp = null;
            for (const ep of endpoints) {
                try {
                    console.debug('[del->]', ep);
                    const resp = await api(ep.url, { method: ep.method });
                    console.debug('[del<-]', ep, resp);
                    if (!resp || resp.error) throw new Error(resp?.error || 'server_error');
                    okResp = resp;
                    break;
                } catch (e) {
                    console.warn('[del x]', ep, e?.message || e);
                    lastErr = e;
                }
            }

            if (!okResp) {
                alert('Delete failed: ' + (lastErr?.message || lastErr || 'unknown error'));
                return;
            }

            // Visually tombstone the message
            try {
                msgEl.classList.add('deleted');
                const bubble = msgEl.querySelector('.bubble') || msgEl;
                bubble.innerHTML = `<div class="deleted-note">You deleted this message</div>`;
                // Prevent showing the menu again for a tombstoned one
                const menu = msgEl.querySelector('.bubble-menu'); if (menu) menu.remove();
                const dots = msgEl.querySelector('.bubble-menu-btn'); if (dots) dots.remove();
            } catch { }
        };
    })();

    window.MessagesApp = window.MessagesApp || {};
    // Advertise native support so ui-overlays skips the fallback rail entirely.
    window.MessagesApp.nativeRailSupportsDelete = () => true;

    // ===== Message actions rail (⋮ + 🙂) =====
    (function installMsgActionsRail() {
        const MA = (window.MessagesApp ||= {});
        const log = (...a) => console.debug('[rail]', ...a);

        // Prefer the global extractor (set earlier), fall back to a local impl.
        const extractMsgMeta =
            (window.MessagesApp && window.MessagesApp.extractMsgMeta) ||
            function (msgEl) {
                const pick = (el) => (el && el.dataset) ? el.dataset : {};
                const probe = msgEl.matches?.('[data-msg-id],[data-id],[data-mid],[data-message-id],[data-sender-id],[data-user-id],[data-ts],[data-time],[data-created-at]')
                    ? msgEl
                    : (msgEl.querySelector?.('[data-msg-id],[data-id],[data-mid],[data-message-id],[data-sender-id],[data-user-id],[data-ts],[data-time],[data-created-at]') || msgEl);
                const d = pick(probe);

                let id = +(d.msgId || d.id || d.mid || d.messageId || 0);
                if (!id && msgEl.id) { const m = /(\d+)$/.exec(msgEl.id); if (m) id = +m[1]; }

                let senderId = +(d.senderId || d.userId || d.uid || 0);

                let tsSec = null;
                const rawTs = d.ts || d.time || d.createdAt || d.created_at || null;
                if (rawTs) {
                    if (/^\d+$/.test(rawTs)) {
                        const n = +rawTs; tsSec = (n > 2e10) ? Math.round(n / 1000) : n;
                    } else {
                        const t = new Date(rawTs).getTime();
                        if (Number.isFinite(t)) tsSec = Math.round(t / 1000);
                    }
                } else {
                    const tEl = msgEl.querySelector?.('time[datetime]');
                    if (tEl?.getAttribute) {
                        const t = new Date(tEl.getAttribute('datetime')).getTime();
                        if (Number.isFinite(t)) tsSec = Math.round(t / 1000);
                    }
                }
                return { id, senderId, tsSec };
            };

        // Only skip if the native rail explicitly confirms it supports delete-for-all.
        // Otherwise, install the fallback rail so the policy logic actually runs.
        const wantsNative = !!MA.useNativeMsgRail;
        const nativeOk = (typeof MA.nativeRailSupportsDelete === 'function') && MA.nativeRailSupportsDelete() === true;

        if (wantsNative && nativeOk) {
            console.debug('[rail] native rail present and supports delete → skipping fallback');
            return;
        }
        if (wantsNative && !nativeOk) {
            console.warn('[rail] native rail requested but no delete support advertised → installing fallback rail');
        }

        // ---- settings/meta helpers
        function getConvId() { return (MA.state?.convId) | 0; }
        function getConvMeta() {
            const s = MA.state || {};
            const cid = getConvId();
            const meta = s.convMeta?.get?.(cid) || null;
            return { cid, meta, meId: (s.meId | 0) };
        }

        async function ensureSettingsLoaded() {
            const { cid, meta } = getConvMeta();
            if (!cid) return;
            if (!meta) {
                log('settings missing → fetching…', { cid });
                try { await MA.syncConvSettings?.(cid); } catch { }
            }
        }

        // ---- server-aligned delete predicate (author-only + allow + effective_from + window)
        function canDeleteForAll(msgEl) {
            const { meta: conv, meId } = getConvMeta();
            const ds = msgEl?.dataset || {};

            // --- per-message snapshot takes absolute precedence ---
            // data-deletable="1|0"; data-delete-deadline="ISO/epoch(ms)/epoch(s)"
            if (ds.deletable === '0') {
                log('delete: per-msg says NOT deletable → deny', { ds });
                return false;
            }
            if (ds.deletable === '1') {
                // If we have a deadline, enforce it; otherwise allow.
                const ddlRaw = ds.deleteDeadline || ds.delete_deadline;
                if (ddlRaw) {
                    const ddlMs = /^\d+$/.test(ddlRaw)
                        ? (+ddlRaw > 2e10 ? +ddlRaw : (+ddlRaw * 1000))
                        : new Date(ddlRaw).getTime();
                    const ok = Number.isFinite(ddlMs) ? (Date.now() <= ddlMs) : true;
                    log('delete: per-msg deletable with deadline check', { ds, ddlMs, allow: ok });
                    return ok;
                }
                log('delete: per-msg deletable → allow', { ds });
                return true;
            }

            // --- fall back to conversation policy ---
            if (!conv || !conv.message_delete_enabled) {
                log('delete: disabled at convo', { conv });
                return false;
            }

            const { senderId, tsSec } = extractMsgMeta(msgEl);

            if (!senderId || senderId !== meId) {
                log('delete: not author', { senderId, meId });
                return false;
            }

            if (conv.delete_effective_from_ts) {
                if (!tsSec) {
                    log('delete: no message ts → deny (server will too)');
                    return false;
                }
                const okAfter = (tsSec * 1000) >= conv.delete_effective_from_ts;
                if (!okAfter) {
                    log('delete: message predates effective_from', {
                        tsSec, effective_from_ms: conv.delete_effective_from_ts
                    });
                    return false;
                }
            } else {
                log('delete: no effective_from in settings → deny (matches server)', conv);
                return false;
            }

            const win = conv.message_delete_window_sec; // null => unlimited
            if (win == null) {
                log('delete: unlimited window → allow');
                return true;
            }
            if (!tsSec) {
                log('delete: finite window but missing ts → deny');
                return false;
            }
            const age = Math.floor(Date.now() / 1000) - tsSec;
            const ok = age <= Math.max(0, +win | 0);
            log('delete: window check', { age_sec: age, window_sec: win, allow: ok });
            return ok;
        }

        // ---- menu item builder (no "copy" option)
        function computeMenuItems(msgEl) {
            const items = [];

            // 1) download (if any attachment element is inside)
            const media = msgEl.querySelector('img.att, video.att, audio.att, [data-download]');
            if (media) {
                items.push({
                    id: 'download',
                    label: 'Download',
                    run: () => {
                        const a = document.createElement('a');
                        const src = media.getAttribute('data-download') || media.currentSrc || media.src;
                        if (!src) return;
                        a.href = src; a.download = '';
                        document.body.appendChild(a); a.click(); a.remove();
                    }
                });
            }

            // 2) delete for everyone (server-aligned)
            if (canDeleteForAll(msgEl)) {
                items.push({
                    id: 'delete',
                    label: 'Delete for everyone',
                    run: () => window.MessagesApp?.onDeleteForAll?.(msgEl)
                });
            }

            // 3) optional local delete (only if app provides a handler)
            if (typeof window.MessagesApp?.onDeleteForMe === 'function') {
                items.push({
                    id: 'delete-me',
                    label: 'Delete (for me)',
                    run: () => window.MessagesApp.onDeleteForMe(msgEl)
                });
            }

            log('menu items', { msgEl, count: items.length, ids: items.map(i => i.id) });
            return items;
        }

        // ---- ensure the rail for one message
        function ensureRail(msgEl) {
            if (!(msgEl instanceof HTMLElement)) return;
            if (msgEl.classList.contains('sysmsg')) return; // never on system messages

            let rail = msgEl.querySelector('.msg-actions');
            if (!rail) {
                rail = document.createElement('div');
                rail.className = 'msg-actions';
                msgEl.appendChild(rail);
            }

            // dots button
            let dots = rail.querySelector('.bubble-menu-btn');
            if (!dots) {
                dots = document.createElement('button');
                dots.type = 'button';
                dots.className = 'bubble-menu-btn';
                dots.setAttribute('aria-label', 'Message options');
                dots.textContent = '⋮';
                rail.appendChild(dots);
            }

            // menu container
            let menu = rail.querySelector('.bubble-menu');
            if (!menu) {
                menu = document.createElement('div');
                menu.className = 'bubble-menu';
                rail.appendChild(menu);
            }

            // react button — show as soon as we *think* it’s allowed; if settings unknown, default show
            let reactBtn = rail.querySelector('.react-btn');
            // decide per-message
            const { meta: conv } = getConvMeta();
            const ds = msgEl.dataset || {};
            const perMsg = ds.reactable == null ? null : ds.reactable === '1';
            const tsSec = ds.ts ? (+ds.ts | 0) : null;

            let rxEnabled;
            if (perMsg !== null) {
                rxEnabled = perMsg; // server snapshot wins
            } else if (conv?.reactions_enabled != null) {
                if (conv.reactions_enabled && conv.reactions_effective_from_ts && tsSec) {
                    rxEnabled = (tsSec * 1000) >= conv.reactions_effective_from_ts;
                } else {
                    rxEnabled = !!conv.reactions_enabled;
                }
            } else {
                rxEnabled = true; // optimistic until settings arrive
            }
            const rxMode = (function () {
                const perMsg = ds.rxMode || ds.reactionMode || ds.reaction_mode || null;
                if (perMsg) return perMsg;  // snapshot on the message wins
                return conv?.reactions_mode || 'both';
            })();

            if (rxEnabled) {
                if (!reactBtn) {
                    reactBtn = document.createElement('button');
                    reactBtn.type = 'button';
                    reactBtn.className = 'react-btn';
                    reactBtn.setAttribute('aria-label', 'React');
                    reactBtn.textContent = '🙂';
                    rail.appendChild(reactBtn);
                    reactBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        msgEl.classList.add('rx-open');

                        // If an app-level overlay exists, let it decide. Otherwise, default palette:
                        if (typeof MA.onReactClick === 'function') {
                            MA.onReactClick(msgEl, { mode: rxMode });   // pass mode hint
                        } else {
                            const ov = document.getElementById('rx-picker');
                            if (ov) { ov.style.display = 'flex'; }
                            else { /* inline palette already installed below */ }
                        }
                    });
                }
                reactBtn.style.display = '';
                log('react: visible', { rxEnabled, conv });
            } else {
                if (reactBtn) reactBtn.remove();
                log('react: hidden (reactions disabled)', { conv });
            }

            // compute actions and show/hide dots appropriately
            const items = computeMenuItems(msgEl);
            if (!items.length) {
                dots.style.display = 'none';
                menu.style.display = 'none';
                msgEl.classList.remove('menu-open');
            } else {
                dots.style.display = '';
                menu.innerHTML = items.map(i => `<div class="item" data-id="${i.id}">${i.label}</div>`).join('');
                menu.querySelectorAll('.item').forEach(el => {
                    el.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const id = el.getAttribute('data-id');
                        const found = items.find(x => x.id === id);
                        found?.run?.();
                        menu.style.display = 'none';
                        msgEl.classList.remove('menu-open');
                    });
                });
                if (!dots._wired) {
                    dots._wired = true;
                    dots.addEventListener('click', (e) => {
                        e.stopPropagation();
                        // close others
                        document.querySelectorAll('.msg.menu-open .bubble-menu').forEach(m => {
                            m.style.display = 'none';
                            m.closest('.msg')?.classList.remove('menu-open');
                        });
                        const open = menu.style.display === 'block';
                        menu.style.display = open ? 'none' : 'block';
                        msgEl.classList.toggle('menu-open', !open);
                    });
                }
            }
        }

        // ---- full refresh pass
        async function refreshAll() {
            await ensureSettingsLoaded(); // fetch once if missing
            document.querySelectorAll('.msg').forEach(ensureRail);
        }

        // expose for manual poke + give per-message debugger
        MA.refreshMessageActions = refreshAll;
        MA.debugMsgActions = (msgElOrSelector) => {
            const el = (typeof msgElOrSelector === 'string') ? document.querySelector(msgElOrSelector) : msgElOrSelector;
            if (!el) return log('debug: no element');
            const canDel = canDeleteForAll(el);
            log('debug for msg', { meta: extractMsgMeta(el), canDeleteForAll: canDel, conv: getConvMeta().meta });
            return canDel;
        };

        // initial run + observe
        refreshAll();
        const mo = new MutationObserver(muts => {
            for (const m of muts) {
                m.addedNodes && m.addedNodes.forEach(n => {
                    if (!(n instanceof HTMLElement)) return;
                    if (n.classList?.contains('msg')) ensureRail(n);
                    n.querySelectorAll?.('.msg').forEach(ensureRail);
                });
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });

        // global click → close menus
        document.addEventListener('click', () => {
            document.querySelectorAll('.msg.menu-open .bubble-menu').forEach(m => {
                m.style.display = 'none';
                m.closest('.msg')?.classList.remove('menu-open');
            });
        });

        log('installed');
    })();

    (function ensureDefaultReactionPicker() {
        const MA = (window.MessagesApp ||= {});
        if (typeof MA.onReactClick === 'function') return;

        const CHOICES = ['👍', '❤️', '😂', '😮', '😢', '😡'];

        function parseLooseJSON(v) {
            if (v == null) return null;
            if (typeof v === 'object') return v;
            if (typeof v !== 'string') return null;
            try { return JSON.parse(v); } catch { }
            if (v.startsWith('"') && v.endsWith('"')) { // double-encoded JSON
                try { return JSON.parse(JSON.parse(v)); } catch { }
            }
            return null;
        }

        async function toggleUnicode(msgId, unicode) {
            const api = MA.api?.api || (async () => { throw new Error('api missing'); });
            const url = `/dm/messages/${msgId}/reactions/toggle`;
            const body = { reaction_key: `u:${unicode}` };

            console.debug('[rx][call->]', { url, body });

            try {
                const resp = await api(url, { method: 'POST', body });
                console.debug('[rx][call<-]', resp);
            } catch (e) {
                // Try to pull out any JSON-ish info to avoid the "Unexpected token" path elsewhere
                const raw = (e && (e.detail || e.body || e.responseText || e.message)) || e;
                const parsed = parseLooseJSON(String(raw));
                console.error('[rx][call x]', { raw, parsed });
                alert('Reaction failed: ' + (parsed?.error || parsed?.message || e?.message || 'server_error'));
            }
        }

        // very small inline palette
        function openPalette(atEl, msgId) {
            closePalette();
            const p = document.createElement('div');
            p.id = 'rx-inline';
            p.style.cssText = 'position:absolute;z-index:2000;display:flex;gap:6px;padding:6px 8px;border:1px solid #333;border-radius:10px;background:#111';
            CHOICES.forEach(ch => {
                const b = document.createElement('button');
                b.type = 'button'; b.textContent = ch;
                b.style.cssText = 'font-size:18px;line-height:1;border:none;background:transparent;cursor:pointer';
                b.addEventListener('click', (e) => { e.stopPropagation(); toggleUnicode(msgId, ch).then(closePalette); });
                p.appendChild(b);
            });
            document.body.appendChild(p);

            const r = atEl.getBoundingClientRect();
            p.style.left = `${Math.round(r.left)}px`;
            p.style.top = `${Math.round(r.top - 40)}px`;

            setTimeout(() => {
                const closer = (ev) => {
                    if (!p.contains(ev.target)) closePalette();
                };
                p._closer = closer;
                document.addEventListener('click', closer);
            }, 0);
        }

        function closePalette() {
            const p = document.getElementById('rx-inline');
            if (p) { document.removeEventListener('click', p._closer || (() => { })); p.remove(); }
        }

        function getMsgId(msgEl) {
            const tryOne = (el) => {
                const d = el?.dataset || {};
                return +(d.msgId || d.id || d.messageId || 0);
            };
            let id = tryOne(msgEl);
            if (!id) {
                const probe = msgEl.querySelector?.('[data-msg-id],[data-id],[data-message-id]');
                if (probe) id = tryOne(probe);
            }
            if (!id && msgEl.id) {
                const m = /(\d+)$/.exec(msgEl.id);
                if (m) id = +m[1];
            }
            return id || 0;
        }

        MA.onReactClick = (msgEl) => {
            const id = getMsgId(msgEl);
            if (!id) { console.warn('[rx] no message id on element'); return; }
            openPalette(msgEl.querySelector('.react-btn') || msgEl, id);
        };
    })();

})(typeof window !== 'undefined' ? window : globalThis);