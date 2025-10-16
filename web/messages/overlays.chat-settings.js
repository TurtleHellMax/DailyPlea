// /web/messages/overlays.chat-settings.js
// Registers: ChatSettingsUI
// Tabs: Info (rename + danger zone), Style (group color + icon), Deletion, Reactions

(function (global) {
    'use strict';
    const UI = (global.UIOverlays = global.UIOverlays || {});

    class ChatSettingsUI {
        constructor({
            GROUP_COLORS = [],
            DEFAULT_PFP_GROUP = '',
            getContext = () => ({ isGroup: false, convId: 0, meta: {}, det: {} }),
            // saves
            onSaveBasics = async () => { },      // { title }
            onSaveStyle = async () => { },       // { color?, iconBlob?, useDefaultIcon? }
            onSaveReactions = async () => { },   // { enabled, mode }
            onSaveDeletion = async () => { },    // { enabled, windowSec|null }
            // actions
            onDeleteForMe = async () => { },
            onLeaveGroup = async () => { },
            onBlockGroup = async () => { },
        } = {}) {
            this.cfg = {
                GROUP_COLORS,
                DEFAULT_PFP_GROUP,
                getContext,
                onSaveBasics,
                onSaveStyle,
                onSaveReactions,
                onSaveDeletion,
                onDeleteForMe,
                onLeaveGroup,
                onBlockGroup,
            };
            this._uid = Math.random().toString(36).slice(2);
            this._installStyles();
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
.cs-content{overflow:auto;display:flex;flex-direction:column;gap:12px;max-height:calc(92vh - 140px)}
.cs-footer{display:flex;gap:8px;justify-content:flex-end;padding:10px;border-top:1px solid var(--border,#333);position:sticky;bottom:0;background:var(--bg,#111)}
.cs-group{border:1px solid var(--border,#333);border-radius:.6rem;padding:10px}
.cs-group>.title{font-weight:700;margin-bottom:8px;opacity:.9}
.cs-row{display:flex;gap:12px;align-items:flex-start;padding:8px;border:1px solid var(--border,#333);border-radius:.5rem;background:var(--bg-2,#181818)}
.cs-row+.cs-row{margin-top:8px}
.lbl{min-width:160px;max-width:240px}
.lbl .name{font-weight:600}
.lbl .desc{opacity:.8;font-size:.9em;margin-top:2px}
.ctl{flex:1;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{border:1px solid var(--border,#333);background:var(--bg-2,#181818);color:inherit;border-radius:.45rem;padding:.35rem .6rem;cursor:pointer}
.btn.secondary{opacity:.9}
.btn.danger{border-color:#813;border-width:1px;background:rgba(130,0,0,.15)}
.btn[disabled]{opacity:.5;cursor:not-allowed}
.pill{border:1px solid var(--border,#333);background:var(--bg-2,#181818);border-radius:999px;padding:.25rem .6rem;cursor:pointer}
.chip{border:1px solid var(--border,#333);background:var(--bg-2,#181818);border-radius:999px;padding:.25rem .6rem;cursor:pointer}
.chip.active{outline:2px solid #fff}
.select,.input{padding:.35rem .5rem;border:1px solid var(--border,#333);background:var(--bg-2,#181818);color:inherit;border-radius:.35rem;cursor:pointer}
.input[type="text"], .input[type="number"]{min-width:240px}
.thumb{width:64px;height:64px;border-radius:14px;border:3px solid var(--border,#333);background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden}
.thumb img{max-width:100%;max-height:100%}
.cs-hide{display:none!important}
.muted{opacity:.8;font-size:.95em}
/* inputs always clickable */
#chat-settings-overlay input,
#chat-settings-overlay select,
#chat-settings-overlay button { pointer-events:auto !important; position:relative; z-index:1; }
#chat-settings-overlay label { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; }
/* checkbox */
#chat-settings-overlay input[type="checkbox"]{
  -webkit-appearance:none; appearance:none; width:20px; height:20px;
  border:2px solid rgba(255,255,255,.95); border-radius:4px; background:transparent;
  display:inline-block; vertical-align:middle; cursor:pointer;
  transition:background .12s ease, border-color .12s ease, box-shadow .12s ease; box-sizing:border-box;
}
#chat-settings-overlay input[type="checkbox"]:checked{ background:#fff; border-color:#fff; }
/* radios (native) */
#chat-settings-overlay input[type="radio"]{ -webkit-appearance:auto; appearance:auto; width:18px; height:18px; cursor:pointer; }
/* disabled selects visible */
#chat-settings-overlay select:disabled { opacity:.55; filter:grayscale(1); pointer-events:none !important; }
/* confirm modal */
.cs-modal{position:fixed;inset:0;display:none;background:rgba(0,0,0,.35);z-index:2100;align-items:center;justify-content:center}
.cs-modal .sheet{background:var(--bg,#111);color:var(--fg,#eee);border:1px solid var(--border,#333);border-radius:.8rem;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:12px;max-width:min(560px,92vw)}
.cs-modal h3{margin:0 0 6px}
.cs-modal .footer{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
`;
            document.head.appendChild(st);
        }

        _ensure() {
            // Reuse overlay if it already exists (idempotent)
            this.root = document.getElementById('chat-settings-overlay');
            if (!this.root) {
                this.root = document.createElement('div');
                this.root.id = 'chat-settings-overlay';
                this.root.style.display = 'none';
                this.root.innerHTML = `
<div class="sheet cs" style="width:min(920px,96vw);max-height:92vh;display:flex;flex-direction:row">
  <aside class="cs-left">
    <input class="cs-search" type="text" placeholder="Search settings…" data-role="search" />
    <div class="cs-tabs" data-role="tabs">
      <button class="btn cs-tab" data-tab="info">Info</button>
      <button class="btn cs-tab" data-tab="style">Style</button>
      <button class="btn cs-tab" data-tab="deletion">Deletion</button>
      <button class="btn cs-tab" data-tab="reactions">Reactions</button>
    </div>
  </aside>
  <main class="cs-right">
    <div class="cs-right-head"><h3>Chat settings</h3></div>
    <div class="cs-content" data-role="content"></div>
    <div class="cs-footer">
      <button class="btn secondary" data-action="close" type="button">Close</button>
      <button class="btn" data-action="save-all" type="button" disabled>Save</button>
    </div>
  </main>
</div>`;
                document.body.appendChild(this.root);
            }

            // Discard & action modals (reuse if present)
            this.discard = document.getElementById('cs-discard-modal');
            if (!this.discard) {
                this.discard = document.createElement('div');
                this.discard.id = 'cs-discard-modal';
                this.discard.className = 'cs-modal';
                this.discard.innerHTML = `
<div class="sheet">
  <h3>Discard changes?</h3>
  <div class="muted">You have unsaved changes.</div>
  <div class="footer">
    <button class="btn secondary" data-x="cancel" type="button">Cancel</button>
    <button class="btn" data-x="discard" type="button">Discard</button>
  </div>
</div>`;
                document.body.appendChild(this.discard);
            }

            this.action = document.getElementById('cs-action-modal');
            if (!this.action) {
                this.action = document.createElement('div');
                this.action.id = 'cs-action-modal';
                this.action.className = 'cs-modal';
                this.action.innerHTML = `
<div class="sheet">
  <h3 data-ref="title">Confirm</h3>
  <div class="muted" data-ref="body"></div>
  <div class="footer">
    <button class="btn secondary" data-y="cancel" type="button">Cancel</button>
    <button class="btn danger" data-y="ok" type="button">OK</button>
  </div>
</div>`;
                document.body.appendChild(this.action);
            }

            // cache refs
            this.q = this.root.querySelector('[data-role="search"]');
            this.tabs = this.root.querySelector('[data-role="tabs"]');
            this.content = this.root.querySelector('[data-role="content"]');

            // Wire events only once
            if (!this.root.__csWired) {
                // backdrop click
                this.root.addEventListener('click', (e) => { if (e.target === this.root) this._maybeClose(); });

                // footer buttons
                this.root.addEventListener('click', (e) => {
                    const act = e.target.closest?.('[data-action]')?.dataset.action;
                    if (!act) return;
                    if (act === 'close') this._maybeClose();
                    else if (act === 'save-all') this._saveAll();
                });

                // discard modal events
                this.discard.addEventListener('click', (e) => {
                    if (e.target === this.discard) return this._hideDiscard();
                    const k = e.target.closest?.('[data-x]')?.dataset.x;
                    if (!k) return;
                    if (k === 'cancel') this._hideDiscard();
                    if (k === 'discard') { this._hideDiscard(); this._reallyClose(); }
                });

                // action modal generic OK/Cancel
                this.action.addEventListener('click', (e) => {
                    if (e.target === this.action) return this._hideAction();
                    const k = e.target.closest?.('[data-y]')?.dataset.y;
                    if (!k) return;
                    if (k === 'cancel') this._hideAction();
                    if (k === 'ok') { const fn = this._actionOk; this._hideAction(); this._actionOk = null; if (fn) fn(); }
                });

                // ESC closes overlay (or modals first)
                window.addEventListener('keydown', (e) => {
                    if (this.action.style.display !== 'none') { if (e.key === 'Escape') this._hideAction(); return; }
                    if (this.discard.style.display !== 'none') { if (e.key === 'Escape') this._hideDiscard(); return; }
                    if (this.root.style.display === 'none') return;
                    if (e.key === 'Escape') { e.preventDefault(); this._maybeClose(); }
                });

                // tab clicks
                this.tabs.addEventListener('click', (e) => {
                    const b = e.target.closest('.cs-tab'); if (!b) return;
                    this.activeTab = b.dataset.tab || 'info';
                    this.q.value = '';
                    this._render();
                });

                // search
                this.q.addEventListener('input', () => this._render());

                // delegated CHANGE events
                this.content.addEventListener('change', (e) => {
                    const t = e.target;

                    if (t.matches('[data-setting="group-name"]')) {
                        this.state.info.title = t.value;
                    } else if (t.matches('[data-setting="rx-enabled"]')) {
                        this.state.reactions.enabled = t.checked; this._render();
                    } else if (t.matches('[data-setting="rx-mode"]')) {
                        this.state.reactions.mode = t.value;
                    } else if (t.matches('[data-setting="del-enabled"]')) {
                        this.state.deletion.enabled = t.checked; this._render();
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
                        if (!this._canEditStyle) return;
                        const f = t.files && t.files[0];
                        if (f) {
                            this._pendingIconFile = f; this._useDefaultIcon = false;
                            const url = URL.createObjectURL(f);
                            const img = this.content.querySelector('[data-ref="style-img"]');
                            const ring = this.content.querySelector('[data-ref="style-thumb"]');
                            if (img) { img.src = url; img.dataset.default = '0'; }
                            if (ring) ring.style.background = '#000';
                        }
                    }
                    this._updateFooterButtons();
                });

                // also react to INPUT on group name to enable Save as you type
                this.content.addEventListener('input', (e) => {
                    if (e.target.matches('[data-setting="group-name"]')) {
                        this.state.info.title = e.target.value;
                        this._updateFooterButtons();
                    }
                });

                // delegated clicks (chips, toggles, danger actions)
                this.content.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-action]');
                    if (btn) {
                        const act = btn.dataset.action;
                        if (act === 'style-color') {
                            if (!this._canEditStyle) return;
                            const val = btn.dataset.value;
                            this.state.style.color = val;
                            this.content.querySelectorAll('[data-action="style-color"]').forEach(x => x.classList.toggle('active', x.dataset.value === val));
                            const ring = this.content.querySelector('[data-ref="style-thumb"]');
                            const img = this.content.querySelector('[data-ref="style-img"]');
                            if (ring) {
                                ring.style.borderColor = val;
                                ring.style.background = (img?.dataset.default === '1') ? val : '#000';
                            }
                            this._updateFooterButtons();
                        } else if (act === 'style-use-default') {
                            if (!this._canEditStyle) return;
                            this._pendingIconFile = null; this._useDefaultIcon = true;
                            const img = this.content.querySelector('[data-ref="style-img"]');
                            const ring = this.content.querySelector('[data-ref="style-thumb"]');
                            if (img) { img.src = this.cfg.DEFAULT_PFP_GROUP; img.dataset.default = '1'; }
                            if (ring) ring.style.background = this.state.style.color;
                            this._updateFooterButtons();
                        } else if (act === 'danger-delete') {
                            this._confirmAction({
                                title: 'Delete this chat for you?',
                                body: 'This removes the conversation from your list. Others will keep their copy.',
                                okText: 'Delete',
                                onOk: async () => { await this.cfg.onDeleteForMe(); this.hide(); }
                            });
                        } else if (act === 'danger-leave') {
                            this._confirmAction({
                                title: 'Leave this group?',
                                body: 'You will stop receiving new messages and the conversation is removed from your list.',
                                okText: 'Leave',
                                onOk: async () => { await this.cfg.onLeaveGroup(); this.hide(); }
                            });
                        } else if (act === 'danger-block') {
                            this._confirmAction({
                                title: 'Block this group?',
                                body: 'Blocks the conversation and future messages. You can unblock later from settings.',
                                okText: 'Block',
                                onOk: async () => { await this.cfg.onBlockGroup(); this.hide(); }
                            });
                        }
                        return;
                    }

                    // wrappers toggle checkboxes
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

                this.root.__csWired = true;
            }

            this.activeTab = 'info';
        }

        async show(tab = 'info') {
            this.activeTab = tab;
            const ctx = this.cfg.getContext() || {};
            const meta = ctx.meta || {};
            const det = ctx.det || {};
            this._isGroup = !!ctx.isGroup;
            this._isOwner = !!(det.is_owner || det.isOwner);
            this._canEditBasics = this._isGroup && this._isOwner;         // rename
            this._canEditStyle = this._isGroup && this._isOwner;          // color + icon
            this._canEditSettings = this._isGroup ? this._isOwner : true; // reactions + deletion

            const currentTitle =
                (det.title && det.title.trim()) ||
                (meta.name && meta.name.trim()) ||
                '';

            this.state = {
                info: { title: this._isGroup ? currentTitle : '' },
                style: { color: meta.color || '#ffffff', photo: meta.photo || this.cfg.DEFAULT_PFP_GROUP },
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
        _showDiscard() { this.discard.style.display = 'flex'; }
        _hideDiscard() { this.discard.style.display = 'none'; }
        _showAction() { this.action.style.display = 'flex'; }
        _hideAction() { this.action.style.display = 'none'; }
        _maybeClose() { this._computeDirty() ? this._showDiscard() : this._reallyClose(); }
        _reallyClose() { this.hide(); }

        _confirmAction({ title, body, okText = 'OK', onOk }) {
            this.action.querySelector('[data-ref="title"]').textContent = title || 'Confirm';
            this.action.querySelector('[data-ref="body"]').textContent = body || '';
            this.action.querySelector('[data-y="ok"]').textContent = okText;
            this._actionOk = async () => {
                try {
                    const okBtn = this.action.querySelector('[data-y="ok"]');
                    okBtn.disabled = true;
                    await onOk?.();
                } catch (e) {
                    const msg = (global.MessagesApp?.utils?.errMsg?.(e) || e?.message || 'Failed');
                    alert(msg);
                } finally {
                    const okBtn = this.action.querySelector('[data-y="ok"]');
                    if (okBtn) okBtn.disabled = false;
                }
            };
            this._showAction();
        }

        _setInitialFromState() {
            this._initial = JSON.parse(JSON.stringify(this.state));
            this._initialUseDefaultIcon = false;
            this._initialPendingIcon = null;
            this._dirty = false;
        }

        _isBasicsDirty() {
            if (!this._canEditBasics) return false;
            const before = (this._initial.info.title || '').trim();
            const now = (this.state.info.title || '').trim();
            return before !== now;
        }
        _isStyleDirty() {
            if (!this._canEditStyle) return false;
            const colorChanged = this.state.style.color !== this._initial.style.color;
            const iconChange = !!this._pendingIconFile || (!!this._useDefaultIcon && !this._initialUseDefaultIcon);
            return colorChanged || iconChange;
        }
        _isRxDirty() {
            if (!this._canEditSettings) return false;
            return this.state.reactions.enabled !== this._initial.reactions.enabled
                || this.state.reactions.mode !== this._initial.reactions.mode;
        }
        _isDelDirty() {
            if (!this._canEditSettings) return false;
            return this.state.deletion.enabled !== this._initial.deletion.enabled
                || (this.state.deletion.enabled && this.state.deletion.windowSec !== this._initial.deletion.windowSec)
                || (!this.state.deletion.enabled && this._initial.deletion.enabled);
        }
        _computeDirty() {
            this._dirty = this._isBasicsDirty() || this._isStyleDirty() || this._isRxDirty() || this._isDelDirty();
            return this._dirty;
        }
        _updateFooterButtons() {
            const saveBtn = this.root.querySelector('[data-action="save-all"]');
            if (saveBtn) saveBtn.disabled = !this._computeDirty();
        }

        async _saveAll() {
            if (!this._computeDirty()) return;
            const ops = [];

            if (this._isBasicsDirty()) {
                ops.push(this.cfg.onSaveBasics({ title: (this.state.info.title || '').trim() }));
            }
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
                this._pendingIconFile = null;
                this._useDefaultIcon = false;
                this._setInitialFromState();
            } finally {
                this._updateFooterButtons();
            }
        }

        _render() {
            const q = (this.q.value || '').trim().toLowerCase();

            // DM: hide Info + Style (rename, icon, color are group-only)
            this.tabs.querySelectorAll('.cs-tab').forEach(b => {
                const cat = b.dataset.tab;
                const hide = (!this._isGroup && (cat === 'info' || cat === 'style'));
                b.classList.toggle('cs-hide', hide);
                b.classList.toggle('active', cat === this.activeTab);
            });

            const groups = {
                info: this._isGroup ? this._groupInfo() : null,
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
            ['info', 'style', 'deletion', 'reactions'].forEach(cat => {
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
                const dmHide = (!this._isGroup && (cat === 'info' || cat === 'style'));
                b.classList.toggle('cs-hide', dmHide || !leftShown.has(cat));
            });

            this._updateFooterButtons();
        }

        _groupInfo() {
            const g = document.createElement('div'); g.className = 'cs-group';
            g.innerHTML = `<div class="title">Group info</div>`;

            const can = this._canEditBasics;
            const desc = can ? 'You are the owner and can rename this group.'
                : 'Only the group owner can change this.';

            const rName = document.createElement('div');
            rName.className = 'cs-row'; rName.setAttribute('data-keywords', 'name title rename');
            rName.innerHTML = `
<div class="lbl">
  <div class="name">Group name</div>
  <div class="desc">${desc}</div>
</div>
<div class="ctl">
  <input data-setting="group-name" class="input" type="text" maxlength="120"
         placeholder="Group name"
         ${can ? '' : 'disabled'}
         value="${(this.state.info.title || '').replace(/"/g, '&quot;')}">
</div>`;
            g.appendChild(rName);

            const rDanger = document.createElement('div');
            rDanger.className = 'cs-row'; rDanger.setAttribute('data-keywords', 'delete leave block danger');
            rDanger.innerHTML = `
<div class="lbl">
  <div class="name">Danger zone</div>
  <div class="desc">These actions affect your access to this conversation.</div>
</div>
<div class="ctl">
  <button class="btn danger" data-action="danger-delete" type="button">Delete for me</button>
  <button class="btn danger" data-action="danger-leave"  type="button">Leave group</button>
  <button class="btn danger" data-action="danger-block"  type="button">Block group</button>
</div>`;
            g.appendChild(rDanger);

            return g;
        }

        _groupStyle() {
            const g = document.createElement('div'); g.className = 'cs-group';
            g.innerHTML = `<div class="title">Style</div>`;

            const can = this._canEditStyle;

            const rowC = document.createElement('div');
            rowC.className = 'cs-row'; rowC.setAttribute('data-keywords', 'style color theme');
            rowC.innerHTML = `
<div class="lbl">
  <div class="name">Group color</div>
  <div class="desc">${can ? 'Accent for the avatar ring and theming.' : 'Only the group owner can change this.'}</div>
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
                if (!can) { b.disabled = true; b.title = 'Owner only'; }
                chips.appendChild(b);
            });

            const rowI = document.createElement('div');
            rowI.className = 'cs-row'; rowI.setAttribute('data-keywords', 'icon avatar image upload picture');
            rowI.innerHTML = `
<div class="lbl">
  <div class="name">Group icon</div>
  <div class="desc">${can ? 'Upload PNG/JPG/WebP or use default.' : 'Only the group owner can change this.'}</div>
</div>
<div class="ctl">
  <div class="thumb" data-ref="style-thumb"><img data-ref="style-img" alt=""></div>
  <label class="pill" ${can ? '' : 'style="opacity:.6; pointer-events:none"'} >
    <span>Choose image</span>
    <input data-setting="style-file" type="file" accept="image/png,image/jpeg,image/webp" style="display:none" ${can ? '' : 'disabled'}>
  </label>
  <button class="btn" data-action="style-use-default" type="button" ${can ? '' : 'disabled'} title="${can ? '' : 'Owner only'}">Use default</button>
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

            const lock = !this._canEditSettings;
            const enabled = !!this.state.reactions.enabled;
            const rawMode = this.state.reactions.mode || 'both';
            const mode = (rawMode === 'none') ? 'both' : rawMode;

            row.innerHTML = `
<div class="lbl">
  <div class="name">Reactions</div>
  <div class="desc">${lock ? 'Only the group owner can change this.' : 'Enable reactions and choose allowed types.'}</div>
</div>
<div class="ctl">
  <label data-toggle="rx-enabled" ${lock ? 'style="opacity:.6; pointer-events:none"' : ''}>
    <input data-setting="rx-enabled" type="checkbox" ${enabled ? 'checked' : ''} ${lock ? 'disabled' : ''}> Enable
  </label>
  <label style="display:flex;align-items:center;gap:8px;">
    Type
    <select class="select" data-setting="rx-mode" ${(enabled && !lock) ? '' : 'disabled'}>
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
            const row = document.createElement('div');
            row.className = 'cs-row'; row.setAttribute('data-keywords', 'deletion delete window time seconds minutes hours');
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

    // --- Robust exports (prevents "not a constructor") ---
    UI.ChatSettingsUI = ChatSettingsUI;                               // namespaced export
    if (!global.ChatSettingsUI) global.ChatSettingsUI = ChatSettingsUI; // global convenience
    UI.provide?.('ChatSettingsUI', ChatSettingsUI);                   // optional hub helper

})(typeof window !== 'undefined' ? window : globalThis);
