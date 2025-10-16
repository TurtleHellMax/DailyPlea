// /web/messages/overlays.friend-picker.js
// Registers FriendPickerUI and installs default wiring:
// - Auto-wires #btn-newdm and #btn-newgroup (robust to re-renders)
// - For group edit/view, shows union(members, friends) and excludes "me"
// - Supports mode alias: 'view-members' → 'view'
(function (global) {
    'use strict';
    const UI = (global.UIOverlays = global.UIOverlays || {});
    const MA = (global.MessagesApp = global.MessagesApp || {});

    const $id = (s) => document.getElementById(s);
    const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
    const esc = (s = '') =>
        String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const COLORS = (MA.GROUP_COLORS || []).map(c => c.val).filter(Boolean);
    const pickColor = () => (COLORS.length ? COLORS[(Math.random() * COLORS.length) | 0] : '#8ab4f8');

    const uniqById = (arr) => {
        const m = new Map();
        (arr || []).forEach(u => { if (u && u.id != null) m.set(+u.id, u); });
        return [...m.values()];
    };

    const mapUserLike = (u) => {
        const x = u?.user || u || {};
        return {
            id: x.id ?? x.user_id ?? x.member_id ?? null,
            username: x.username ?? x.first_username ?? null,
            first_username: x.first_username ?? x.username ?? null,
            display_name: x.display_name ?? x.name ?? null,
            profile_photo: x.profile_photo ?? x.photo ?? null,
            bio: x.bio ?? ''
        };
    };

    class FriendPickerOverlay {
        constructor(cfg = {}) {
            this.cfg = Object.assign({
                fetchFriends: async () => [],
                fetchGroupMembers: async () => [],
                onStartDm: () => { },
                onCreateGroup: () => { },
                onEditGroup: () => { },
                getConvContext: () => ({ isGroup: false, meId: 0 }),
                usernameFor: (id) => `user-${id}`,
                DEFAULT_PFP_DM: '/web/default-avatar.png'
            }, cfg);
            this.state = {
                mode: 'dm',
                friendsCache: [],
                idToFriend: new Map(),
                selectedIds: new Set(),
                initialSelectedIds: new Set()
            };
            this._ensure();
        }

        _ensure() {
            this.overlay = $id('friend-picker-overlay');
            if (!this.overlay) {
                this.overlay = document.createElement('div');
                this.overlay.id = 'friend-picker-overlay';
                this.overlay.className = 'overlay';
                this.overlay.style.display = 'none';
                this.overlay.innerHTML = `
<div class="sheet" style="width:min(680px,96vw)">
  <h3 id="fp-title">People</h3>
  <input id="fp-q" class="cs-search" placeholder="Search…" />
  <div id="fp-selected" style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0"></div>
  <div id="fp-list" style="display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow:auto"></div>
  <div id="fp-cta" style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
    <button class="btn secondary" id="fp-cancel" type="button">Cancel</button>
    <button class="btn" id="fp-submit" type="button" disabled>Create Group</button>
  </div>
</div>`;
                document.body.appendChild(this.overlay);
            }
            this.listEl = $id('fp-list');

            on(this.overlay, 'click', (e) => { if (e.target === this.overlay) this.close(); });
            on(document, 'keydown', (e) => { if (this.overlay.style.display !== 'none' && e.key === 'Escape') this.close(); });
            on($id('fp-q'), 'input', () => this.renderFriends(this.state.friendsCache));
            on($id('fp-cancel'), 'click', () => this.close());
            on($id('fp-submit'), 'click', () => this._submit());
        }

        async _loadListForMode(mode) {
            const meId = this.cfg.getConvContext().meId | 0;
            if (mode === 'group-edit' || mode === 'view') {
                let mem = [];
                try { mem = await this.cfg.fetchGroupMembers(); } catch { }
                let fr = [];
                try { fr = await this.cfg.fetchFriends(); } catch { }
                return uniqById([...mem.map(mapUserLike), ...fr.map(mapUserLike)])
                    .filter(u => (u.id | 0) !== meId);
            }
            const friends = (await this.cfg.fetchFriends()).map(mapUserLike)
                .filter(u => (u.id | 0) !== meId);
            return friends;
        }

        async open(mode = 'dm', opts = {}) {
            if (mode === 'view-members') mode = 'view'; // alias support

            const meId = this.cfg.getConvContext().meId | 0;
            this.state.mode = mode;

            const cleanedPre = (opts.preselectIds || []).filter((id) => (id | 0) !== meId);
            this.state.selectedIds = new Set(cleanedPre);
            this.state.initialSelectedIds = new Set(cleanedPre);

            this.overlay.style.display = 'flex';

            const title = $id('fp-title');
            title.textContent =
                mode === 'dm' ? 'Start a conversation' :
                    mode === 'group-create' ? 'Create a Group' :
                        mode === 'group-edit' ? 'Edit Group Members' :
                            'Group Members';

            const cta = $id('fp-cta');
            cta.style.display = (mode === 'group-create' || mode === 'group-edit') ? '' : 'none';

            this._refreshSubmitState();
            const list = await this._loadListForMode(mode);
            this.renderFriends(list);
        }

        close() { this.overlay.style.display = 'none'; }

        _refreshChips() {
            const box = $id('fp-selected'); if (!box) return;
            box.innerHTML = '';
            [...this.state.selectedIds].forEach(uid => {
                const u = this.state.idToFriend.get(uid) || {};
                const label = u.display_name || u.name || u.first_username || u.username || `user-${uid}`;
                const chip = document.createElement('div');
                chip.className = 'chip';
                chip.innerHTML = `<span>${esc(label)}</span><span class="x" title="Remove">✕</span>`;
                on(chip.querySelector('.x'), 'click', (e) => {
                    e.stopPropagation();
                    this.state.selectedIds.delete(uid);
                    this.renderFriends(this.state.friendsCache);
                    this._refreshChips();
                    this._refreshSubmitState();
                });
                box.append(chip);
            });
        }

        _refreshSubmitState() {
            const btn = $id('fp-submit'); if (!btn) return;
            if (this.state.mode === 'group-create') {
                btn.textContent = 'Create Group';
                btn.disabled = (this.state.selectedIds.size < 2); // need 2 others (group of >=3 with me)
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

            if (!this.listEl) return;
            this.listEl.innerHTML = '';

            const q = ($id('fp-q')?.value || '').trim().toLowerCase();
            const items = list.filter(u => {
                const nm = (u.display_name || u.name || u.first_username || u.username || '').toLowerCase();
                const bio = (u.bio || '').toLowerCase();
                return !q || nm.includes(q) || bio.includes(q);
            });

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
    ${mode === 'dm'
                        ? `<button class="btn person-message" type="button">Message</button>`
                        : mode === 'group-create' || mode === 'group-edit'
                            ? `<input type="checkbox" class="checkbox person-check" ${checked ? 'checked' : ''}>`
                            : ''}
  </div>`;

                if (mode === 'dm') {
                    const go = () => { this.close(); this.cfg.onStartDm(u); };
                    on(row, 'click', (e) => { if (e.target.closest('.person-message')) return; go(); });
                    on(row.querySelector('.person-message'), 'click', (e) => { e.stopPropagation(); go(); });
                } else if (mode === 'group-create' || mode === 'group-edit') {
                    const toggle = () => {
                        if (this.state.selectedIds.has(u.id)) this.state.selectedIds.delete(u.id);
                        else this.state.selectedIds.add(u.id);
                        this.renderFriends(this.state.friendsCache);
                        this._refreshChips();
                        this._refreshSubmitState();
                    };
                    on(row, 'click', toggle);
                    on(row.querySelector('.person-check'), 'click', (e) => { e.stopPropagation(); toggle(); });
                }

                this.listEl.append(row);
            });

            this._refreshChips();
        }

        _submit() {
            const meId = this.cfg.getConvContext().meId | 0;

            if (this.state.mode === 'group-create') {
                if (this.state.selectedIds.size < 2) return;
                this.cfg.onCreateGroup([...this.state.selectedIds]);  // server adds me implicitly
            } else if (this.state.mode === 'group-edit') {
                const before = new Set(this.state.initialSelectedIds);
                const after = new Set(this.state.selectedIds);
                const add = [...after].filter(x => !before.has(x));
                const remove = [...before].filter(x => !after.has(x) && (x | 0) !== meId); // never remove self
                if (!add.length && !remove.length) return;
                this.cfg.onEditGroup({ add, remove });
            }
            this.close();
        }
    }

    UI.provide?.('FriendPickerOverlay', FriendPickerOverlay);

    // ---------- Default wiring (only if app hasn’t provided one) ----------
    function installDefaultWiring() {
        if (MA.openFriendPicker) return;

        const fetchFriends = MA.chat?.fetchFriends || (async () => []);
        const fetchGroupMembers = async () => {
            const det = MA.state?.currentConvDetail || {};
            const members = Array.isArray(det.members) ? det.members : [];
            return members.map(mapUserLike);
        };

        const fp = new FriendPickerOverlay({
            fetchFriends,
            fetchGroupMembers,
            onStartDm: MA.chat?.startDmWith || (() => { }),
            onCreateGroup: async (ids) => {
                // Use the app’s existing group creation endpoint
                try {
                    const color = pickColor();
                    const res = await MA.api?.api?.('/dm/conversations', { method: 'POST', body: { user_ids: ids, color } });
                    const cid = res?.conversation_id || res?.id;
                    if (cid) {
                        await MA.chat?.loadConversations?.({ blockingMeta: true });
                        await MA.chat?.fetchConvMeta?.(cid);
                        await MA.chat?.openConversation?.(cid);
                    }
                } catch (e) {
                    alert(MA.utils?.errMsg?.(e) || (e?.message || 'Failed to create group'));
                }
            },
            onEditGroup: async ({ add, remove }) => {
                try {
                    const cid = MA.state?.convId | 0; if (!cid) return;
                    const body = {};
                    if (add?.length) body.add_user_ids = add;
                    if (remove?.length) body.remove_user_ids = remove;
                    await MA.api?.api?.(`/dm/conversations/${cid}/members`, { method: 'PATCH', body });
                    await MA.chat?.fetchConvMeta?.(cid);
                } catch (e) {
                    alert(MA.utils?.errMsg?.(e) || (e?.message || 'Failed to edit group'));
                }
            },
            getConvContext: () => ({ isGroup: !!MA.state?.currentConvDetail?.is_group, meId: MA.state?.meId || 0 }),
            usernameFor: (id) => (MA.usernameFor ? MA.usernameFor(id) : `user-${id}`),
            DEFAULT_PFP_DM: MA.DEFAULT_PFP_DM || '/web/default-avatar.png'
        });

        // public entrypoint used by wiring/chat-menu
        MA.openFriendPicker = (mode = 'dm', opts = {}) => fp.open(mode, opts);
        UI.provide?.('friendPicker', fp);

        // ---- AUTO-WIRE toolbar buttons (robust to DOM changes) ----
        function wireButtons() {
            const dm = $id('btn-newdm');
            const gr = $id('btn-newgroup');
            if (dm && !dm.__fp) {
                dm.__fp = true;
                dm.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); MA.openFriendPicker?.('dm'); });
            }
            if (gr && !gr.__fp) {
                gr.__fp = true;
                gr.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); MA.openFriendPicker?.('group-create'); });
            }
        }
        wireButtons();
        new MutationObserver(wireButtons).observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installDefaultWiring, { once: true });
    } else {
        installDefaultWiring();
    }
})(typeof window !== 'undefined' ? window : globalThis);
