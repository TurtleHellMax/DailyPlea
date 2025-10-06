(function (global) {
    'use strict';
    // ui-overlays.js
    // Pure UI components + wiring extracted from your inline script.
    // Usage example is at the end of this file.

    /* ---------- tiny utils (no app logic here) ---------- */
    const $id = (s) => document.getElementById(s);
    const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const by = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    /* default no-op callbacks */
    const noop = () => { };
    const kTrue = () => true;

    /* ---------- Friend display helpers (UI-only) ---------- */
    function friendDisplay(u) {
        const raw = u?.display_name || u?.name || u?.first_username || u?.username || 'User';
        return String(raw);
    }
    function eqSets(a, b) { if (a.size !== b.size) return false; for (const v of a) if (!b.has(v)) return false; return true; }

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
         * @param {(uid:number)=>string} [cfg.usernameFor] // optional label helper
         * @param {string} cfg.DEFAULT_PFP_DM
         */
        constructor(cfg) {
            this.cfg = Object.assign({
                fetchFriends: async () => [],
                onStartDm: noop,
                onCreateGroup: noop,
                onEditGroup: noop,
                getConvContext: () => ({ isGroup: false, meId: 0 }),
                usernameFor: (id) => `user-${id}`,
                DEFAULT_PFP_DM: '',
            }, cfg || {});
            this.state = {
                mode: 'dm',
                friendsCache: [],
                idToFriend: new Map(),
                selectedIds: new Set(),
                initialSelectedIds: new Set(),
            };
            this._wireStatic();
        }

        _wireStatic() {
            // base overlay shell is assumed to exist in DOM; only UI behavior lives here
            this.overlay = $id('overlay');
            this.userList = $id('user-list');

            // close on backdrop & Esc
            this.overlay?.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });

            // search
            $id('user-q')?.addEventListener('input', () => this.renderFriends(this.state.friendsCache));
            // cancel
            $id('btn-cancel')?.addEventListener('click', () => this.close());
            // submit (create/edit/close)
            $id('btn-group-submit')?.addEventListener('click', () => this._submit());
        }

        async open(mode = 'dm', opts = {}) {
            this.state.mode = mode;
            this.state.selectedIds = new Set(opts.preselectIds || []);
            this.state.initialSelectedIds = new Set(opts.preselectIds || []);
            if (this.overlay) this.overlay.style.display = 'flex';
            const title = $id('sheet-title');
            if (title) {
                title.textContent =
                    mode === 'dm' ? 'Start a conversation'
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

        close() { if (this.overlay) this.overlay.style.display = 'none'; }

        _refreshSelectedChips() {
            const box = $id('selected-chips');
            if (!box) return;
            box.innerHTML = '';
            [...this.state.selectedIds].forEach(uid => {
                const u = this.state.idToFriend.get(uid) || {};
                const label = friendDisplay(u);
                const chip = document.createElement('div');
                chip.className = 'chip';
                chip.innerHTML = `<span>${esc(label)}</span><span class="x" title="Remove">✕</span>`;
                chip.querySelector('.x')?.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.state.selectedIds.delete(uid);
                    this.renderFriends(this.state.friendsCache);
                    this._refreshSelectedChips();
                    this._refreshGroupSubmitState();
                });
                box.append(chip);
            });
        }

        _refreshGroupSubmitState() {
            const btn = $id('btn-group-submit');
            const mode = this.state.mode;
            if (!btn) return;

            if (mode === 'group-create') {
                btn.textContent = 'Create Group';
                btn.disabled = (this.state.selectedIds.size < 2);
            } else if (mode === 'group-edit') {
                btn.textContent = 'Save Changes';
                const changed = !eqSets(this.state.selectedIds, this.state.initialSelectedIds);
                btn.disabled = !changed;
            } else {
                btn.textContent = 'Close';
                btn.disabled = false;
            }
            const cta = $id('group-cta');
            if (cta) cta.style.display = (mode === 'group-create' || mode === 'group-edit') ? '' : 'none';
        }

        renderFriends(list = []) {
            this.state.friendsCache = list;
            this.state.idToFriend.clear();
            list.forEach(u => this.state.idToFriend.set(u.id, u));

            if (!this.userList) return;
            this.userList.innerHTML = '';

            const q = ($id('user-q')?.value || '').trim().toLowerCase();
            const items = list.filter(u => {
                if (!q) return true;
                return (u.username || '').toLowerCase().includes(q)
                    || (u.first_username || '').toLowerCase().includes(q)
                    || (u.bio || '').toLowerCase().includes(q);
            });

            const mode = this.state.mode;
            items.forEach(u => {
                const row = document.createElement('div');
                row.className = 'person';
                const label = friendDisplay(u);
                const checked = this.state.selectedIds.has(u.id);
                const isDefaultAvatar = !u.profile_photo;

                let right = '';
                if (mode === 'dm') {
                    right = `<div class="act"><button class="btn person-message">Message</button></div>`;
                } else if (mode === 'group-create' || mode === 'group-edit') {
                    right = `<div class="act"><input type="checkbox" class="checkbox person-check" ${checked ? 'checked' : ''}/></div>`;
                } else {
                    right = `<div class="act"></div>`;
                }

                row.innerHTML = `
        <img class="pfp ${isDefaultAvatar ? 'pixel' : ''}" src="${u.profile_photo || this.cfg.DEFAULT_PFP_DM}" alt="">
        <div>
          <div class="name">${esc(label)}</div>
          <div class="bio">${esc(u.bio || '')}</div>
        </div>
        ${right}
      `;

                if (mode === 'dm') {
                    row.addEventListener('click', (e) => { if (e.target.closest('.person-message')) return; this.cfg.onStartDm(u); });
                    row.querySelector('.person-message')?.addEventListener('click', (e) => { e.stopPropagation(); this.cfg.onStartDm(u); });
                } else if (mode === 'group-create' || mode === 'group-edit') {
                    const toggle = () => {
                        if (this.state.selectedIds.has(u.id)) this.state.selectedIds.delete(u.id);
                        else this.state.selectedIds.add(u.id);
                        this.renderFriends(this.state.friendsCache);
                        this._refreshSelectedChips();
                        this._refreshGroupSubmitState();
                    };
                    row.addEventListener('click', toggle);
                    row.querySelector('.person-check')?.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
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
                const before = new Set(this.state.initialSelectedIds);
                const after = new Set(this.state.selectedIds);
                const add = [...after].filter(x => !before.has(x));
                const remove = [...before].filter(x => !after.has(x));
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
        /**
         * @param {Object} cfg
         * @param {() => Promise<void>} cfg.syncColors
         * @param {() => Record<number,string>} cfg.getColorMap // convId is implied in outer app
         * @param {(hexOrNull:string|null)=>Promise<void>} cfg.setMyColor
         * @param {() => {meId:number, meName:string, mePhoto?:string, isGroup:boolean}} cfg.getContext
         * @param {string} cfg.DEFAULT_PFP_DM
         */
        constructor(cfg) {
            this.cfg = Object.assign({
                syncColors: async () => { },
                getColorMap: () => ({}),
                setMyColor: async () => { },
                getContext: () => ({ meId: 0, meName: 'Me', mePhoto: '', isGroup: false }),
                DEFAULT_PFP_DM: ''
            }, cfg || {});
            this._ensure();
        }

        _ensure() {
            this.root = document.createElement('div');
            this.root.id = 'my-color-overlay';
            this.root.className = 'overlay';
            this.root.style.display = 'none';
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
            this.root.addEventListener('click', e => { if (e.target === this.root) this.hide(); });

            this._name = this.root.querySelector('#my-color-name');
            this._pfp = this.root.querySelector('#my-color-pfp');
            this._input = this.root.querySelector('#my-color-input');
            this.root.querySelector('#my-color-clear')?.addEventListener('click', () => { this._input.value = '#e6e6e6'; });
            this.root.querySelector('#my-color-cancel')?.addEventListener('click', () => this.hide());
            this.root.querySelector('#my-color-save')?.addEventListener('click', async () => {
                const val = String(this._input.value || '').toLowerCase();
                const toSet = (val === '#e6e6e6') ? null : val;
                await this.cfg.setMyColor(toSet);
                this.hide();
            });
        }

        async show() {
            const ctx = this.cfg.getContext();
            if (!ctx.isGroup) return;
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
       Chat Menu (3-dots) UI-only
       =========================== */
    class ChatMenuUI {
        /**
         * @param {Object} cfg
         * @param {HTMLElement} cfg.menuEl   // #chat-menu
         * @param {HTMLElement} cfg.buttonEl // #chat-menu-btn
         * @param {() => {isGroup:boolean, isOwner:boolean}} cfg.getContext
         * @param {Object<string,Function>} cfg.handlers  // { rename, manage, viewMembers, restyle, myColor, leave, blockGroup, deleteDm, blockUser }
         */
        constructor(cfg) {
            this.cfg = Object.assign({
                menuEl: null,
                buttonEl: null,
                getContext: () => ({ isGroup: false, isOwner: false }),
                handlers: {},
            }, cfg || {});
            this.menu = this.cfg.menuEl;
            this.btn = this.cfg.buttonEl;

            this._wire();
        }

        _wire() {
            if (!this.menu || !this.btn) return;
            this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });

            document.addEventListener('click', (e) => {
                if (!e.target.closest('.menu') && e.target !== this.btn) this.hide();
            });

            // also close bubble menus if your app has them (parent can hook separately)
        }

        hide() { if (this.menu) this.menu.style.display = 'none'; }
        toggle() {
            if (!this.menu) return;
            if (this.menu.style.display === 'none' || !this.menu.style.display) {
                this.render();
                this.menu.style.display = 'block';
            } else {
                this.menu.style.display = 'none';
            }
        }

        render() {
            if (!this.menu) return;
            const { isGroup, isOwner } = this.cfg.getContext();

            const items = [];
            if (isGroup) {
                if (isOwner) {
                    items.push({ id: 'rename', label: 'Rename group' });
                    items.push({ id: 'manage', label: 'Manage members' });
                } else {
                    items.push({ id: 'view-members', label: 'View members' });
                }
                items.push({ id: 'restyle', label: 'Restyle Group' });
                items.push({ id: 'my-color', label: 'My Message Color' });
                items.push({ id: 'leave', label: 'Leave group' });
                items.push({ id: 'block-group', label: 'Block this group' });
            } else {
                items.push({ id: 'delete-dm', label: 'Delete chat (for me)' });
                items.push({ id: 'block-user', label: 'Block user' });
            }

            this.menu.innerHTML = items.map(i => `<div class="item" data-id="${i.id}">${esc(i.label)}</div>`).join('');
            by('.item', this.menu).forEach(el => {
                el.onclick = () => {
                    const id = el.dataset.id;
                    this.hide();
                    const h = this.cfg.handlers || {};
                    ({
                        'rename': h.rename || noop,
                        'manage': h.manage || noop,
                        'view-members': h.viewMembers || noop,
                        'restyle': h.restyle || noop,
                        'my-color': h.myColor || noop,
                        'leave': h.leave || noop,
                        'block-group': h.blockGroup || noop,
                        'delete-dm': h.deleteDm || noop,
                        'block-user': h.blockUser || noop,
                    }[id])();
                };
            });
        }
    }

    /* ==================================
       Restyle Group overlay (UI-only)
       ================================== */
    class RestyleGroupUI {
        /**
         * @param {Object} cfg
         * @param {Array<{key:string,val:string}>} cfg.GROUP_COLORS
         * @param {string} cfg.DEFAULT_PFP_GROUP
         * @param {() => { color?:string, photo?:string, isGroup:boolean }} cfg.getMeta
         * @param {(payload:{color?:string, iconBlob?:Blob, useDefaultIcon?:boolean})=>Promise<void>} cfg.onSave
         */
        constructor(cfg) {
            this.cfg = Object.assign({
                GROUP_COLORS: [],
                DEFAULT_PFP_GROUP: '',
                getMeta: () => ({ isGroup: false }),
                onSave: async () => { },
            }, cfg || {});
            this._ensure();
        }

        _ensure() {
            this.root = document.createElement('div');
            this.root.id = 'restyle-overlay';
            this.root.className = 'overlay';
            this.root.style.display = 'none';
            this.root.innerHTML = `
      <div class="sheet" style="width:min(720px,94vw)">
        <h3>Restyle Group</h3>

        <div class="pf-preview">
          <div class="thumb"><img id="restyle-preview" alt="preview"></div>
          <div class="muted">PNG will be generated at up to <b>512px</b> (longest side). Final file must be ≤ <b>1&nbsp;MB</b>.</div>
        </div>

        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:8px 0 10px">
          <div style="font-weight:700">Color</div>
          <div id="restyle-color-choices" style="display:flex;flex-wrap:wrap;gap:8px"></div>
        </div>

        <div class="file-row">
          <label class="pill">
            <span>Choose image</span>
            <input id="restyle-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" style="display:none">
          </label>
          <span class="muted">or drag & drop onto the canvas</span>
          <div id="restyle-filename" class="muted" style="font-size:13px"></div>
          <button class="btn" id="restyle-clear" type="button">Use default</button>
        </div>

        <div class="editor" style="margin-top:10px">
          <div class="stage" id="restyle-drop">
            <canvas id="restyle-canvas" width="320" height="320"></canvas>
          </div>

          <div class="controls">
            <div class="ctl">
              <div class="muted" style="margin-bottom:6px">Zoom</div>
              <input id="restyle-zoom" type="range" min="0" max="1" step="0.01" value="0.5">
            </div>
            <div class="ctl">
              <div class="muted" style="margin-bottom:6px">Rotate</div>
              <input id="restyle-rot" type="range" min="-180" max="180" step="1" value="0">
            </div>
          </div>

          <div class="actions" style="display:flex;gap:10px;margin-top:4px;justify-content:flex-end">
            <button class="btn secondary" id="restyle-cancel" type="button">Cancel</button>
            <button class="btn" id="restyle-save" disabled>Save</button>
          </div>
          <div class="note">Tips: drag the image to reposition. Use zoom/rotate. Output is PNG with transparency preserved.</div>
        </div>
      </div>`;
            document.body.append(this.root);
            this.root.addEventListener('click', (e) => { if (e.target === this.root) this.hide(); });

            // White thumbs for ranges once
            if (!document.getElementById('restyle-white-range')) {
                const st = document.createElement('style');
                st.id = 'restyle-white-range';
                st.textContent = `
#restyle-overlay input[type="range"]::-webkit-slider-thumb { background:#fff !important; }
#restyle-overlay input[type="range"]::-moz-range-thumb { background:#fff !important; }
#restyle-overlay input[type="range"]:active::-webkit-slider-thumb { background:#fff !important; }
#restyle-overlay input[type="range"]:active::-moz-range-thumb { background:#fff !important; }`;
                document.head.appendChild(st);
            }

            // cache dom
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
            this.clearBtn.addEventListener('click', () => this._clearToDefault());
            this.cancelBtn.addEventListener('click', () => this.hide());
            this.fileIn.addEventListener('change', () => {
                const f = this.fileIn.files?.[0];
                if (f) this._setImageFile(f);
            });
            this.drop.addEventListener('dragover', e => e.preventDefault());
            this.drop.addEventListener('drop', e => {
                e.preventDefault();
                const f = e.dataTransfer?.files?.[0];
                if (f) this._setImageFile(f);
            });

            // canvas gestures
            this.canvas.addEventListener('pointerdown', e => {
                this._dragging = true; this._last = { x: e.clientX, y: e.clientY };
                this.canvas.setPointerCapture(e.pointerId);
            });
            const endDrag = e => { this._dragging = false; try { this.canvas.releasePointerCapture(e.pointerId); } catch { } };
            this.canvas.addEventListener('pointerup', endDrag);
            this.canvas.addEventListener('pointercancel', endDrag);
            this.canvas.addEventListener('pointerleave', endDrag);
            this.canvas.addEventListener('pointermove', e => {
                if (!this._dragging) return;
                const dx = e.clientX - this._last.x, dy = e.clientY - this._last.y;
                this._last = { x: e.clientX, y: e.clientY };
                this._pos.x += dx; this._pos.y += dy;
                this._redraw(); this._markDirty();
            });

            // sliders
            this.zoomEl.addEventListener('input', () => { this._zoom = parseFloat(this.zoomEl.value); this._redraw(); this._markDirty(); });
            this.rotEl.addEventListener('input', () => { this._rot = parseFloat(this.rotEl.value) * Math.PI / 180; this._redraw(); this._markDirty(); });

            // save
            this.saveBtn.addEventListener('click', async () => {
                const payload = {};
                if (this._selectedColor && this._selectedColor !== this._initialColor) payload.color = this._selectedColor;

                if (this._imgBitmap) {
                    const { png } = await this._exportPNGMax512();
                    if (png) payload.iconBlob = new Blob([png], { type: 'image/png' });
                } else if (this._clearedToDefault) {
                    payload.useDefaultIcon = true;
                }

                await this.cfg.onSave(payload);
                this.hide();
            });
        }

        async show() {
            const meta = this.cfg.getMeta();
            if (!meta.isGroup) return;

            // init state
            this._hadCustomIcon = !!meta.photo && meta.photo !== this.cfg.DEFAULT_PFP_GROUP;
            this._clearedToDefault = false;
            this._imgBitmap = null;
            this._imgW = 0; this._imgH = 0;
            this._pos = { x: 0, y: 0 };
            this._zoom = 0.5; this._rot = 0;
            this.zoomEl.value = '0.5'; this.rotEl.value = '0';

            this._selectedColor = meta.color || '#ffffff';
            this._initialColor = this._selectedColor;
            this._dirty = false; this.saveBtn.disabled = true;

            // color chips
            this.colorBox.innerHTML = '';
            this.cfg.GROUP_COLORS.forEach(c => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn';
                b.style.cssText = `border-color:${c.val};background:${c.val};color:#000`;
                b.textContent = c.key;
                if (c.val === this._selectedColor) b.style.outline = '2px solid #fff';
                b.onclick = () => {
                    this._selectedColor = c.val;
                    by('.btn', this.colorBox).forEach(x => x.style.outline = '');
                    b.style.outline = '2px solid #fff';
                    this._paintPreview(meta);
                    this._markDirty();
                };
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
            this.preview.classList.toggle('is-default', showDefault);
            this.preview.onerror = () => { this.preview.src = this.cfg.DEFAULT_PFP_GROUP; };
            this.preview.src = showDefault ? this.cfg.DEFAULT_PFP_GROUP : (meta.photo || this.cfg.DEFAULT_PFP_GROUP);

            const thumb = this.root.querySelector('.pf-preview .thumb');
            thumb.style.borderColor = this._selectedColor;
            thumb.style.background = showDefault ? this._selectedColor : '#000';
        }

        _scaleForZoom() { const MIN = 0.25, MAX = 6; return MIN + this._zoom * (MAX - MIN); }

        _redraw() {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            if (!this._imgBitmap) return;
            this.ctx.save();
            this.ctx.translate(this.canvas.width / 2 + this._pos.x, this.canvas.height / 2 + this._pos.y);
            this.ctx.rotate(this._rot);
            const s = this._scaleForZoom();
            const dw = this._imgW * s, dh = this._imgH * s;
            this.ctx.drawImage(this._imgBitmap, -dw / 2, -dh / 2, dw, dh);
            this.ctx.restore();
        }

        _clearToDefault() {
            this._imgBitmap = null; this._imgW = this._imgH = 0;
            this._pos = { x: 0, y: 0 }; this._zoom = 0.5; this._rot = 0;
            this.zoomEl.value = '0.5'; this.rotEl.value = '0';
            this.fileIn.value = ''; this.fileName.textContent = '';
            this._clearedToDefault = true;
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this._paintPreview(this.cfg.getMeta());
            this._markDirty();
        }

        async _setImageFile(file) {
            try {
                const bmp = await this._loadBitmap(file);
                this._imgBitmap = bmp;
                this._imgW = bmp.width; this._imgH = bmp.height;
                this._pos = { x: 0, y: 0 };
                this._zoom = 0.5; this._rot = 0;
                this.zoomEl.value = '0.5'; this.rotEl.value = '0';
                this.fileName.textContent = file.name;
                this._clearedToDefault = false;
                this._redraw();
                const obj = URL.createObjectURL(file);
                this.preview.src = obj;
                this.root.querySelector('.pf-preview .thumb').style.background = '#000';
                this._markDirty();
            } catch (e) {
                alert('Could not read image: ' + (e?.message || e));
            }
        }

        _loadBitmap(file) {
            return new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = async () => {
                    try { resolve(await createImageBitmap(new Blob([r.result]))); }
                    catch (e) { reject(e); }
                };
                r.onerror = () => reject(r.error);
                r.readAsArrayBuffer(file);
            });
        }

        async _exportPNGMax512() {
            const BYTES_MAX = 1024 * 1024;
            let size = 512;
            const renderTo = async (px) => {
                const out = ('OffscreenCanvas' in window) ? new OffscreenCanvas(px, px)
                    : Object.assign(document.createElement('canvas'), { width: px, height: px });
                const octx = out.getContext('2d');
                octx.clearRect(0, 0, px, px);

                if (this._imgBitmap) {
                    const s = this._scaleForZoom();
                    octx.save();
                    octx.translate(px / 2 + (this._pos.x * (px / this.canvas.width)), px / 2 + (this._pos.y * (px / this.canvas.height)));
                    octx.rotate(this._rot);
                    const dw = this._imgW * s * (px / this.canvas.width);
                    const dh = this._imgH * s * (px / this.canvas.height);
                    octx.drawImage(this._imgBitmap, -dw / 2, -dh / 2, dw, dh);
                    octx.restore();
                }
                const blob = out.convertToBlob ? await out.convertToBlob({ type: 'image/png' })
                    : await new Promise(res => out.toBlob(res, 'image/png'));
                return new Uint8Array(await blob.arrayBuffer());
            };

            let png = this._imgBitmap ? await renderTo(size) : null;
            while (png && png.length > BYTES_MAX && size > 192) {
                size = Math.floor(size * 0.85);
                png = await renderTo(size);
            }
            if (png && png.length > BYTES_MAX) throw new Error('Icon too large even after resizing');
            return { png, size };
        }
    }

    /* ==========================================
       Basic composer / controls wiring (UI-only)
       ========================================== */
    function wireBasicChatControls({
        onAttachClick = () => $id('file')?.click(),
        onFilesChosen = async (files) => { },
        onSend = () => { },
        onStartRecording = () => { },
        onStopRecording = () => { },
        isRecording = () => false,
    } = {}) {
        $id('btn-attach')?.addEventListener('click', onAttachClick);
        const fileEl = $id('file');
        if (fileEl) {
            fileEl.onchange = async (e) => {
                const files = Array.from(e.target.files || []);
                if (files.length) await onFilesChosen(files);
                e.target.value = '';
            };
        }

        $id('btn-send')?.addEventListener('click', onSend);
        $id('text')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
        });

        const voice = $id('btn-voice');
        if (voice) {
            const startRec = (e) => { e.preventDefault(); voice.textContent = 'Recording… release to stop'; onStartRecording(); };
            const stopRec = (e) => { e.preventDefault(); voice.textContent = 'Hold to record'; onStopRecording(); };
            voice.addEventListener('pointerdown', startRec);
            voice.addEventListener('pointerup', stopRec);
            voice.addEventListener('pointercancel', stopRec);
            voice.addEventListener('mouseleave', () => { if (isRecording()) stopRec(new Event('pointerup')); });
        }
    }
    const api = {
        FriendPickerUI,
        MyColorOverlayUI,
        ChatMenuUI,
        RestyleGroupUI,
        wireBasicChatControls
    };

    if (typeof module === 'object' && module.exports) module.exports = api; // CommonJS
    global.UIOverlays = api;                                                // Browser global

    // Optional convenience globals
    if (!global.FriendPickerUI) global.FriendPickerUI = FriendPickerUI;
    if (!global.MyColorOverlayUI) global.MyColorOverlayUI = MyColorOverlayUI;
    if (!global.ChatMenuUI) global.ChatMenuUI = ChatMenuUI;
    if (!global.RestyleGroupUI) global.RestyleGroupUI = RestyleGroupUI;
    if (!global.wireBasicChatControls) global.wireBasicChatControls = wireBasicChatControls;

})(typeof window !== 'undefined' ? window : globalThis);