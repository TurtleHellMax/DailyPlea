// /web/messages/overlays.chat-settings.js
// Registers: ChatSettingsUI
// Tabs: Info (rename + danger zone), Style (group color + icon), Deletion, Reactions

(function (global) {
    'use strict';
    const UI = (global.UIOverlays = global.UIOverlays || {});
    const MA = (global.MessagesApp = global.MessagesApp || {});

    class ChatSettingsUI {
        constructor({
            GROUP_COLORS = [],
            DEFAULT_PFP_GROUP = '',
            getContext = () => ({ isGroup: false, convId: 0, meta: {}, det: {} }),
            // saves
            onSaveBasics = async () => { },
            onSaveStyle = async () => { },
            onSaveReactions = async () => { },
            onSaveDeletion = async () => { },
            // actions (may be omitted; we’ll wire to the real endpoints)
            onDeleteForMe,
            onLeaveGroup,
            onBlockGroup,
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

            // pick the app api, wrapping once if needed
            const rawApi = (MA.api && (MA.api.api || MA.api)) || null;
            this._api = rawApi
                ? (rawApi.__uiOverlaysWrapped ? rawApi : (UI.wrapApi ? UI.wrapApi(rawApi) : rawApi))
                : null;

            // hard-wire the three danger actions to the real routes if not provided by host
            const mustApi = async (url, opts) => {
                if (!this._api) throw new Error('api missing');
                return this._api(url, opts || {});
            };

            // POST /dm/conversations/:id/delete_for_me
            const callDeleteForMe = async () => {
                const { convId } = this.cfg.getContext() || {};
                if (!convId) throw new Error('missing conversation id');
                await mustApi(`/dm/conversations/${convId}/delete_for_me`, { method: 'POST' });
                try {
                    window.dispatchEvent(new CustomEvent('chat:removed', { detail: { convId } }));
                    MA.chat?.removeLocal?.(convId);
                } catch { }
            };

            // POST /dm/conversations/:id/leave  (groups only)
            const callLeaveGroup = async () => {
                const { convId, isGroup } = this.cfg.getContext() || {};
                if (!convId) throw new Error('missing conversation id');
                if (!isGroup) throw new Error('not_a_group');
                await mustApi(`/dm/conversations/${convId}/leave`, { method: 'POST' });
                try {
                    window.dispatchEvent(new CustomEvent('chat:left', { detail: { convId } }));
                    MA.chat?.removeLocal?.(convId);
                } catch { }
            };

            // POST /dm/conversations/:id/block (works for groups and DMs; server removes you from group)
            const callBlockGroup = async () => {
                const { convId } = this.cfg.getContext() || {};
                if (!convId) throw new Error('missing conversation id');
                await mustApi(`/dm/conversations/${convId}/block`, { method: 'POST' });
                try {
                    window.dispatchEvent(new CustomEvent('chat:blocked', { detail: { convId } }));
                    MA.chat?.removeLocal?.(convId);
                } catch { }
            };
            this.cfg.onDeleteForMe = this.cfg.onDeleteForMe || callDeleteForMe;
            this.cfg.onLeaveGroup = this.cfg.onLeaveGroup || callLeaveGroup;
            this.cfg.onBlockGroup = this.cfg.onBlockGroup || callBlockGroup;
            this._uid = Math.random().toString(36).slice(2);
            this._installStyles();
            this._ensure();
            this._photo = { img: null, zoom: 1, rot: 0, panX: 0, panY: 0, dragging: false, dragStart: { x: 0, y: 0 }, panStart: { x: 0, y: 0 }, dataUrl: null };
            this._MAX_BYTES = 1 * 1024 * 1024;
            this._PNG_MIME = 'image/png';
            this._ZOOM_MIN_REL = 0.5;
            this._ZOOM_MAX_REL = 14.0;
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
.thumb{
  width:64px;
  height:64px;
  border-radius:50%;
  border:3px solid var(--border,#333);
  background:#000;
  display:flex;
  align-items:center;
  justify-content:center;
  overflow:hidden;
  box-sizing:border-box;
}
.thumb img{
  width:100%;
  height:100%;
  object-fit:cover;
  display:block;
  border-radius:inherit; /* ensures image corners are round too */
}
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
.cs-edit{display:flex;flex-direction:column;gap:8px;min-width:260px}
.cs-edit .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cs-edit canvas{width:220px;height:220px;max-width:100%;background:#000;border:1px solid var(--border,#333);border-radius:.5rem}
.cs-edit .drop{border:1px dashed var(--border,#333);border-radius:.5rem;padding:6px 8px;text-align:center;opacity:.8}
.cs-edit .muted.ok{color:#9f9}
.cs-edit .muted.err{color:#f99}
#chat-settings-overlay .thumb{
  width:64px;
  height:64px;
  border:3px solid var(--border,#333);
  border-radius:50% !important;
  background:#000;
  display:flex;
  align-items:center;
  justify-content:center;
  overflow:hidden;
  box-sizing:border-box;
  clip-path:circle(50% at 50% 50%); /* ensures round even if something nukes border-radius */
}
#chat-settings-overlay .thumb img{
  width:100%;
  height:100%;
  object-fit:cover;
  display:block;
  border-radius:50% !important;
}
.cs-modal .footer .btn[disabled] { opacity:.6; cursor:progress; }
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
                    if (!this.state) return; // ignore clicks until show() ran
                    this.activeTab = b.dataset.tab || 'info';
                    this.q.value = '';
                    this._render();
                });

                // search
                this.q.addEventListener('input', () => this._render());

                // delegated CHANGE events
                this.content.addEventListener('change', (e) => {
                    const t = e.target;
                    if (!this.state) return;

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
                    if (!this.state) return;
                    if (e.target.matches('[data-setting="group-name"]')) {
                        this.state.info.title = e.target.value;
                        this._updateFooterButtons();
                    }
                });

                // delegated clicks (chips, toggles, danger actions)
                this.content.addEventListener('click', (e) => {
                    if (!this.state) return;
                    const btn = e.target.closest('[data-action]');
                    if (btn) {
                        const act = btn.dataset.action;
                        if (act === 'style-color') {
                            if (!this._canEditStyle) return;
                            const val = btn.dataset.value;
                            this.state.style.color = val;

                            // Dirties the photo so Save will re-bake it against the new color
                            this._markPhotoDirty();

                            this.content.querySelectorAll('[data-action="style-color"]')
                                .forEach(x => x.classList.toggle('active', x.dataset.value === val));

                            const ring = this.content.querySelector('[data-ref="style-thumb"]');
                            const img = this.content.querySelector('[data-ref="style-img"]');

                            if (this._editorEls && this._photo.img) {
                                this._drawEditor(this._editorEls); // shows new bg color behind transparency
                            }
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
                                onOk: async () => {
                                    const { convId, isGroup } = this.cfg.getContext?.() || {};
                                    await this.cfg.onDeleteForMe({ convId, isGroup });
                                    this._notifyRuntimePatch({}); // optional broadcast
                                }
                            });
                        } else if (act === 'danger-leave') {
                            this._confirmAction({
                                title: 'Leave this group?',
                                body: 'You will stop receiving new messages and the conversation is removed from your list.',
                                okText: 'Leave',
                                onOk: async () => {
                                    const { convId } = this.cfg.getContext?.() || {};
                                    await this.cfg.onLeaveGroup({ convId });
                                    this._notifyRuntimePatch({});
                                }
                            });
                        } else if (act === 'danger-block') {
                            const isGroup = !!this._isGroup;
                            this._confirmAction({
                                title: isGroup ? 'Block this group?' : 'Block this user?',
                                body: 'Blocks the conversation and future messages. You can unblock later from settings.',
                                okText: 'Block',
                                onOk: async () => {
                                    const { convId } = this.cfg.getContext?.() || {};
                                    await this.cfg.onBlockGroup({ convId, isGroup });
                                    this._notifyRuntimePatch({});
                                }
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
                const okBtn = this.action.querySelector('[data-y="ok"]');
                try {
                    if (okBtn) okBtn.disabled = true;
                    await onOk?.();           // run host action (may throw)
                    this.hide();              // close the sheet on success
                } catch (e) {
                    const msg = (global.MessagesApp?.utils?.errMsg?.(e) || e?.message || 'Failed');
                    alert(msg);               // make failures visible
                } finally {
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
            const iconChange = this._photoDirty || !!this._pendingIconFile || (!!this._useDefaultIcon && !this._initialUseDefaultIcon);
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
            if (!saveBtn) return;
            if (!this.state) { saveBtn.disabled = true; return; }
            saveBtn.disabled = !this._computeDirty();
        }

        async _saveAll() {
            if (!this._computeDirty()) return;
            const ops = [];
            let rxPatch = null;
            let delPatch = null;
            let stylePatch = null;

            // Basics
            if (this._isBasicsDirty()) {
                ops.push(this.cfg.onSaveBasics({ title: (this.state.info.title || '').trim() }));
            }

            // Style (color + icon)
            if (this._isStyleDirty()) {
                const payload = {};
                if (this.state.style.color !== this._initial.style.color) payload.color = this.state.style.color;

                // Prefer baked canvas if the editor was touched
                if (this._photoDirty) {
                    try {
                        const blob = await this._bakeCurrentPhotoToBlob();
                        if (blob) payload.iconBlob = blob;
                    } catch (e) {
                        alert(e?.message || 'Failed to process image.');
                        return; // abort entire save if icon baking failed
                    }
                } else if (this._pendingIconFile) {
                    payload.iconBlob = this._pendingIconFile;
                } else if (this._useDefaultIcon) {
                    payload.useDefaultIcon = true; // rarely used now; kept for completeness
                }

                if (Object.keys(payload).length) {

                    ops.push(this.cfg.onSaveStyle(payload));
                    stylePatch = { color: this.state.style.color };
                }
            }

            // Reactions + Deletion (unchanged)
            if (this._isRxDirty()) {
                const { enabled, mode } = this.state.reactions;
                ops.push(this.cfg.onSaveReactions({ enabled, mode }));
                rxPatch = { enabled, mode }; // broadcast both together so runtime stays consistent
            }
            if (this._isDelDirty()) {
                const { enabled, windowSec } = this.state.deletion;
                ops.push(this.cfg.onSaveDeletion({ enabled, windowSec: enabled ? windowSec : null }));
                delPatch = { enabled, windowSec: enabled ? windowSec : null };
            }

            try {
                const btn = this.root.querySelector('[data-action="save-all"]');
                if (btn) btn.disabled = true;
                await Promise.all(ops);
                this._notifyRuntimePatch({ rx: rxPatch, del: delPatch, style: stylePatch });

                // reset staged editor state after successful save
                this._pendingIconFile = null;
                this._useDefaultIcon = false;
                this._photoDirty = false;
                this._setInitialFromState();
            } finally {
                this._updateFooterButtons();
            }
        }

        _render() {
            if (!this.state) return; // don’t render until show() initializes state
            const q = (this.q.value || '').trim().toLowerCase();

            // DM: hide Info + Style (rename, icon, color are group-only)
            this.tabs.querySelectorAll('.cs-tab').forEach(b => {
                const cat = b.dataset.tab;
                const hide = (!this._isGroup && (cat === 'style'));
                b.classList.toggle('cs-hide', hide);
                b.classList.toggle('active', cat === this.activeTab);
            });

            const groups = {
                info: this._isGroup ? this._groupInfo() : this._dmInfo(),
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
                const dmHide = (!this._isGroup && (cat === 'style'));
                b.classList.toggle('cs-hide', dmHide || !leftShown.has(cat));
            });

            this._updateFooterButtons();
        }

        // Fill the editor/output background with the group color (used to flatten alpha)
        _fillStageBg(ctx, w, h) {
            const col = (this.state && this.state.style && this.state.style.color) || '#000';
            ctx.fillStyle = col;
            ctx.fillRect(0, 0, w, h);
        }

        // Broadcast a local runtime patch so the rest of the app can immediately reconfigure.
        _notifyRuntimePatch({ rx = null, del = null, style = null } = {}) {
            const ctx = this.cfg.getContext?.() || {};
            const detail = { convId: ctx.convId, reactions: rx, deletion: del, style };
            try { this.cfg.onRuntimePatch?.(detail); } catch { }
            try { window.dispatchEvent(new CustomEvent('chat-settings:updated', { detail })); } catch { }
        }

        // When Style tab opens, prime the editor with the current group photo
        _primeEditorWithCurrent(els) {
            const src = this._photo.dataUrl || this.state.style.photo || this.cfg.DEFAULT_PFP_GROUP;
            const im = new Image();
            // helps avoid canvas taint if your CDN sets proper CORS headers
            try { im.crossOrigin = 'anonymous'; } catch { }
            im.onload = () => {
                this._photo.img = im;
                this._photo.zoom = 1; this._photo.rot = 0; this._photo.panX = 0; this._photo.panY = 0;
                if (els.zoom) els.zoom.value = '0.5';
                if (els.rot) els.rot.value = '0';
                this._photoDirty = false; // opening the panel shouldn't mark it dirty
                this._drawEditor(els);
            };
            im.onerror = () => this._setMsg?.(els.msg, 'Failed to load current photo.');
            im.src = src;
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

        _dmInfo() {
            const g = document.createElement('div'); g.className = 'cs-group';
            g.innerHTML = `<div class="title">Info</div>`;

            // Danger zone (DMs only): Delete for me + Block user
            const rDanger = document.createElement('div');
            rDanger.className = 'cs-row';
            rDanger.setAttribute('data-keywords', 'delete block danger');
            rDanger.innerHTML = `
<div class="lbl">
  <div class="name">Danger zone</div>
  <div class="desc">These actions affect only your account.</div>
</div>
<div class="ctl">
  <button class="btn danger" data-action="danger-delete" type="button">Delete for me</button>
  <button class="btn danger" data-action="danger-block"  type="button">Block user</button>
</div>`;
            g.appendChild(rDanger);

            return g;
        }

        // ---- Photo editor helpers (ported from profile editor) ----
        _clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
        _relFromNormalizedSlider(t) {
            t = this._clamp(Number(t), 0, 1);
            const ZMIN = this._ZOOM_MIN_REL, ZMAX = this._ZOOM_MAX_REL;
            if (t <= 0.5) { const u = t / 0.5; return ZMIN * Math.pow(1 / ZMIN, u); }
            const u = (t - 0.5) / 0.5; return Math.pow(ZMAX, u);
        }
        _paintBlankEdit(canvas) {
            const ctx = canvas.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            // subtle border
            ctx.strokeStyle = 'rgba(255,255,255,.15)';
            ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);

            // helper text
            const msg = 'Drag image here, or click to upload';
            ctx.fillStyle = 'rgba(255,255,255,.75)';
            ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const lines = msg.split(/, /); // two lines for readability
            lines.forEach((line, i) => {
                ctx.fillText(line, canvas.width / 2, canvas.height / 2 + (i ? 10 : -6));
            });
        }
        _drawEditor(els) {
            const { canvas } = els; const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (!this._photo.img) { this._paintBlankEdit(canvas); return; }

            // Flatten transparency onto group color
            this._fillStageBg(ctx, canvas.width, canvas.height);

            const { img, zoom, rot, panX, panY } = this._photo;
            const cw = canvas.width, ch = canvas.height;

            // NEW: pixel-art smoothing toggle
            this._setSmoothing(ctx, !this._isPixelArt());

            ctx.save();
            ctx.translate(cw / 2 + panX, ch / 2 + panY);
            ctx.rotate(rot * Math.PI / 180);
            const baseScale = Math.min(cw / img.width, ch / img.height);
            const s = baseScale * zoom;
            ctx.scale(s, s);
            ctx.drawImage(img, -img.width / 2, -img.height / 2);
            ctx.restore();

            const r = Math.min(cw, ch) * 0.5 - 2; // a small inset
            ctx.save();
            // darken
            ctx.fillStyle = 'rgba(0,0,0,.35)';
            ctx.beginPath();
            ctx.rect(0, 0, cw, ch);
            ctx.arc(cw / 2, ch / 2, r, 0, Math.PI * 2, true);
            ctx.fill('evenodd'); // fills rect minus the circle
            // ring
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(255,255,255,.35)';
            ctx.lineWidth = 2;
            ctx.arc(cw / 2, ch / 2, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();

            this._updateThumbFromCanvas(els);
        }
        _resetEditor(els) {
            this._photo.img = null; this._photo.zoom = 1; this._photo.rot = 0; this._photo.panX = 0; this._photo.panY = 0;
            if (els.zoom) els.zoom.value = '0.5';
            if (els.rot) els.rot.value = '0';
            this._paintBlankEdit(els.canvas);
            this._setMsg(els.msg, '');
        }
        _setMsg(el, text, ok = false) {
            if (!el) return;
            el.textContent = text || '';
            el.className = 'muted ' + (text ? (ok ? 'ok' : 'err') : '');
        }
        _markPhotoDirty() {
            if (!this._canEditStyle) return;
            this._photoDirty = true;
            this._updateFooterButtons();
        }
        // Treat tiny sources as pixel art
        _isPixelArt() {
            const im = this._photo?.img;
            return !!(im && (im.width < 32 || im.height < 32));
        }
        _setSmoothing(ctx, on) {
            ctx.imageSmoothingEnabled = on;
            try { ctx.imageSmoothingQuality = on ? 'high' : 'low'; } catch { }
            // (legacy vendor flags harmless if ignored)
            ctx.msImageSmoothingEnabled = on;
            ctx.webkitImageSmoothingEnabled = on;
        }
        // update 64px thumb preview from the editor canvas
        _updateThumbFromCanvas(els) {
            if (!this._photo.img || !els?.canvas || !els?.thumbImg || !els?.thumb) return;
            try {
                const url = els.canvas.toDataURL('image/png');
                els.thumbImg.src = url;
                els.thumbImg.dataset.default = '0';
                els.thumb.style.background = '#000';

                // NEW: ensure the <img> scales with nearest-neighbor when tiny source
                els.thumbImg.style.imageRendering = this._isPixelArt() ? 'pixelated' : '';
            } catch { }
        }

        // bake current editor state to a 512×512 PNG blob (used by Save)
        async _bakeCurrentPhotoToBlob() {
            const els = this._editorEls;
            if (!this._photo.img || !els?.canvas) return null;

            const size = 512, out = document.createElement('canvas');
            out.width = size; out.height = size;
            const ox = out.getContext('2d');

            this._fillStageBg(ox, size, size);
            this._setSmoothing(ox, !this._isPixelArt());

            ox.save();
            const kx = size / els.canvas.width, ky = size / els.canvas.height;
            ox.translate(size / 2 + (this._photo.panX * kx), size / 2 + (this._photo.panY * ky));
            ox.rotate(this._photo.rot * Math.PI / 180);
            const baseScale = Math.min(size / this._photo.img.width, size / this._photo.img.height);
            const s = baseScale * this._photo.zoom;
            ox.scale(s, s);
            ox.drawImage(this._photo.img, -this._photo.img.width / 2, -this._photo.img.height / 2);
            ox.restore();

            const blob = await new Promise(res => out.toBlob(res, this._PNG_MIME));
            if (!blob) throw new Error('Failed to encode PNG.');
            if (blob.size > this._MAX_BYTES) throw new Error('Processed image is too large (> 1 MB). Zoom/crop more or choose a smaller image.');
            return blob;
        }
        async _setImageFromFile(file, els) {
            if (!file) return;
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                this._photo.img = img;
                this._photo.zoom = 1; this._photo.rot = 0; this._photo.panX = 0; this._photo.panY = 0;
                if (els.zoom) els.zoom.value = '0.5';
                if (els.rot) els.rot.value = '0';
                this._drawEditor(els);
            };
            img.onerror = () => this._setMsg(els.msg, 'Could not load image');
            img.src = url;
        }
        async _applyPhoto(els) {
            if (!this._photo.img) { this._setMsg(els.msg, 'Choose an image first.'); return; }
            const size = 512, out = document.createElement('canvas');
            out.width = size; out.height = size;
            const ox = out.getContext('2d');
            ox.clearRect(0, 0, size, size);
            ox.save();
            // Map pan from stage pixels → output pixels
            const kx = size / els.canvas.width, ky = size / els.canvas.height;
            ox.translate(size / 2 + (this._photo.panX * kx), size / 2 + (this._photo.panY * ky));
            ox.rotate(this._photo.rot * Math.PI / 180);
            const baseScale = Math.min(size / this._photo.img.width, size / this._photo.img.height);
            const s = baseScale * this._photo.zoom;
            ox.scale(s, s);
            ox.drawImage(this._photo.img, -this._photo.img.width / 2, -this._photo.img.height / 2);
            ox.restore();

            const blob = await new Promise(res => out.toBlob(res, this._PNG_MIME));
            if (!blob) { this._setMsg(els.msg, 'Failed to encode PNG'); return; }
            if (blob.size > this._MAX_BYTES) {
                this._setMsg(els.msg, 'Processed image is too large (> 1 MB). Zoom/crop more or choose a smaller image.');
                return;
            }
            const dataUrl = await new Promise(resolve => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsDataURL(blob); });
            // Stage for save + preview
            this._pendingIconFile = blob;
            this._useDefaultIcon = false;
            this._photo.dataUrl = dataUrl;
            this._photoDirty = false

            const img = els.thumbImg; const ring = els.thumb;
            if (img) { img.src = dataUrl; img.dataset.default = '0'; }
            if (ring) { ring.style.background = '#000'; }
            this._setMsg(els.msg, 'Photo ready. Click “Save”.', true);
            this._updateFooterButtons();
        }

        _groupStyle() {
            const g = document.createElement('div'); g.className = 'cs-group';
            g.innerHTML = `<div class="title">Style</div>`;
            const can = this._canEditStyle;

            // Color row
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

            // Photo editor row (canvas is the target)
            const rowI = document.createElement('div');
            rowI.className = 'cs-row'; rowI.setAttribute('data-keywords', 'icon avatar image upload picture editor crop zoom rotate');
            rowI.innerHTML = `
<div class="lbl">
  <div class="name">Group icon</div>
  <div class="desc">${can ? 'Click or drop into the frame. Drag to pan, use sliders to zoom/rotate.' : 'Only the group owner can change this.'}</div>
</div>
<div class="ctl">
  <div class="thumb" data-ref="style-thumb" style="flex:0 0 auto"><img data-ref="style-img" alt=""></div>
  <div class="cs-edit" style="${can ? '' : 'opacity:.6; pointer-events:none'}">
    <canvas data-ref="stage" width="220" height="220" aria-label="Image editor" title="Click or drop an image here"></canvas>
    <div class="row">
      <label style="display:flex;align-items:center;gap:8px;">Zoom
        <input data-ref="zoom" type="range" min="0" max="1" step="0.001" value="0.5">
      </label>
      <label style="display:flex;align-items:center;gap:8px;">Rotate
        <input data-ref="rot" type="range" min="-180" max="180" step="1" value="0">
      </label>
      <button class="btn" data-action="style-clear" type="button">Clear</button>
      <button class="btn" data-action="style-use-default" type="button" title="${can ? '' : 'Owner only'}">Use default</button>
    </div>
    <input data-ref="file" type="file" accept="image/png,image/jpeg,image/webp" style="display:none">
    <div class="muted" data-ref="msg-photo"></div>
  </div>
</div>`;

            // Thumb ring
            const ring = rowI.querySelector('[data-ref="style-thumb"]');
            const img = rowI.querySelector('[data-ref="style-img"]');

            // 🔒 Hard-force the circle shape (wins over any external CSS)
            Object.assign(ring.style, {
                borderRadius: '50%',
                overflow: 'hidden',
                clipPath: 'circle(50% at 50% 50%)', // extra belt-and-suspenders
                boxSizing: 'border-box',
            });
            Object.assign(img.style, {
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                borderRadius: '50%',
                display: 'block',
            });

            ring.style.borderColor = this.state.style.color;
            img.src = this._photo.dataUrl || this.state.style.photo || this.cfg.DEFAULT_PFP_GROUP;
            const isDefault = !this._photo.dataUrl && (!this.state.style.photo || this.state.style.photo === this.cfg.DEFAULT_PFP_GROUP);
            img.dataset.default = isDefault ? '1' : '0';
            ring.style.background = isDefault ? this.state.style.color : '#000';

            // Editor elements + remember for Save
            const els = {
                canvas: rowI.querySelector('[data-ref="stage"]'),
                zoom: rowI.querySelector('[data-ref="zoom"]'),
                rot: rowI.querySelector('[data-ref="rot"]'),
                file: rowI.querySelector('[data-ref="file"]'),
                msg: rowI.querySelector('[data-ref="msg-photo"]'),
                thumb: ring,
                thumbImg: img,
            };
            this._editorEls = els;

            // Initial paint + NEW: load current saved group photo into the editor
            this._paintBlankEdit(els.canvas);
            this._primeEditorWithCurrent(els);
            if (this._photo.img) this._drawEditor(els);

            // Canvas: click opens file picker
            els.canvas.addEventListener('click', () => {
                if (!can) return;
                if (!this._photo?.img) els.file.click();
            });

            // Canvas: pan with mouse
            els.canvas.addEventListener('mousedown', (e) => {
                if (!can || !this._photo.img) return;
                this._photo.dragging = true;
                this._photo.dragStart = { x: e.clientX, y: e.clientY };
                this._photo.panStart = { x: this._photo.panX, y: this._photo.panY };
                this._markPhotoDirty();
            });
            window.addEventListener('mousemove', (e) => {
                if (!this.root || this.root.style.display === 'none') return;
                if (!this._photo.dragging) return;
                this._photo.panX = this._photo.panStart.x + (e.clientX - this._photo.dragStart.x);
                this._photo.panY = this._photo.panStart.y + (e.clientY - this._photo.dragStart.y);
                this._drawEditor(els);
            }, { passive: true });
            window.addEventListener('mouseup', () => { this._photo.dragging = false; }, { passive: true });

            // Canvas: drag & drop
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
                els.canvas.addEventListener(evt, (e) => { if (!can) return; e.preventDefault(); e.stopPropagation(); }, { passive: false });
            });
            els.canvas.addEventListener('drop', (e) => {
                if (!can) return;
                const f = e.dataTransfer?.files && e.dataTransfer.files[0];
                if (f) {
                    this._setImageFromFile(f, els).then(() => { this._markPhotoDirty(); this._drawEditor(els); });
                }
            });

            // Zoom & rotate
            els.zoom.addEventListener('input', () => {
                this._photo.zoom = this._relFromNormalizedSlider(els.zoom.value);
                this._markPhotoDirty();
                this._drawEditor(els);
            });
            els.rot.addEventListener('input', () => {
                this._photo.rot = parseFloat(els.rot.value) || 0;
                this._markPhotoDirty();
                this._drawEditor(els);
            });

            // File picker
            els.file.addEventListener('change', (ev) => {
                const f = ev.target.files && ev.target.files[0];
                if (f) this._setImageFromFile(f, els).then(() => { this._markPhotoDirty(); this._drawEditor(els); });
            });

            // Buttons: Clear / Use default (default loads into editor for adjustment)
            rowI.addEventListener('click', (e) => {
                const b = e.target.closest('[data-action]'); if (!b) return;
                const act = b.dataset.action;
                if (act === 'style-clear') {
                    this._resetEditor(els);
                    this._photoDirty = false; // no icon change will be saved
                    // revert thumb to the currently saved photo
                    const saved = this.state.style.photo || this.cfg.DEFAULT_PFP_GROUP;
                    els.thumbImg.src = saved;
                    els.thumbImg.dataset.default = (saved === this.cfg.DEFAULT_PFP_GROUP) ? '1' : '0';
                    ring.style.background = (saved === this.cfg.DEFAULT_PFP_GROUP) ? this.state.style.color : '#000';
                    this._updateFooterButtons();
                } else if (act === 'style-use-default') {
                    const src = this.cfg.DEFAULT_PFP_GROUP;
                    const imgEl = new Image();
                    imgEl.onload = () => {
                        this._photo.img = imgEl;
                        this._photo.zoom = 1; this._photo.rot = 0; this._photo.panX = 0; this._photo.panY = 0;
                        els.zoom.value = '0.5'; els.rot.value = '0';
                        this._useDefaultIcon = false; // we are editing baked default, not toggling server flag
                        this._markPhotoDirty();
                        this._drawEditor(els);
                    };
                    imgEl.onerror = () => this._setMsg(els.msg, 'Failed to load default image.');
                    imgEl.src = src;
                }
            });

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
