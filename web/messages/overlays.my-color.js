// /web/messages/overlays.my-color.js
// Registers: MyColorOverlayUI (always on window.UIOverlays and window)
// Optional: installs default wiring as window.MessagesApp.myColorOverlay

(function (global) {
    'use strict';
    const UI = (global.UIOverlays = global.UIOverlays || {});
    const MA = (global.MessagesApp = global.MessagesApp || {});
    const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

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
            // Reuse if it already exists (avoid duplicate overlays if the script is loaded twice)
            this.root = document.getElementById('my-color-overlay');
            if (!this.root) {
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
            }

            on(this.root, 'click', e => { if (e.target === this.root) this.hide(); });

            // cache
            this._name = this.root.querySelector('#my-color-name');
            this._pfp = this.root.querySelector('#my-color-pfp');
            this._input = this.root.querySelector('#my-color-input');

            // wire (idempotent: remove old listeners by cloning if needed)
            const clearBtn = this.root.querySelector('#my-color-clear');
            const cancelBtn = this.root.querySelector('#my-color-cancel');
            const saveBtn = this.root.querySelector('#my-color-save');

            clearBtn.onclick = () => { this._input.value = '#e6e6e6'; };
            cancelBtn.onclick = () => this.hide();
            saveBtn.onclick = async () => {
                const val = String(this._input.value || '').toLowerCase();
                const toSet = (val === '#e6e6e6') ? null : val;
                await this.cfg.setMyColor(toSet);
                this.hide();
            };
        }

        async show() {
            const ctx = this.cfg.getContext();
            if (!ctx.isGroup) return;

            this._name.textContent = ctx.meName || 'Me';
            this._pfp.classList.toggle('pixel', !ctx.mePhoto);
            this._pfp.src = ctx.mePhoto || this.cfg.DEFAULT_PFP_DM;

            try { await this.cfg.syncColors(); } catch { }
            const map = (this.cfg.getColorMap() || {});
            const current = map[ctx.meId] || '#e6e6e6';
            this._input.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#e6e6e6';

            this.root.style.display = 'flex';
        }

        hide() { this.root.style.display = 'none'; }
    }

    // --- Robust exports (prevents "not a constructor") ---
    UI.MyColorOverlayUI = MyColorOverlayUI;                              // namespaced export
    if (!global.MyColorOverlayUI) global.MyColorOverlayUI = MyColorOverlayUI; // global convenience
    UI.provide?.('MyColorOverlayUI', MyColorOverlayUI);                  // optional hub method

    // --- Optional default wiring (only if the hub/app hasn’t set one) ---
    function installDefaultWiring() {
        if (MA.myColorOverlay) return;

        const DEFAULT_PFP_DM = MA.DEFAULT_PFP_DM || '/web/default-avatar.png';
        const mc = new MyColorOverlayUI({
            syncColors: async () => {
                try {
                    const cid = MA.state?.convId;
                    if (!cid) return;
                    await MA.api?.syncMsgColors?.(cid, { retry: 1 });
                } catch { }
            },
            getColorMap: () => {
                try { return (MA.api?.getColorMap?.(MA.state?.convId) || {}); } catch { return {}; }
            },
            setMyColor: async (toSet /* null or '#rrggbb' */) => {
                const cid = MA.state?.convId | 0;
                const me = MA.state?.meId | 0;
                if (!cid || !me) return;

                // Best-effort server update; tolerate 404/unsupported routes
                try {
                    if (MA.api?.api) {
                        const body = { color: toSet };
                        try { await MA.api.api(`/dm/conversations/${cid}/my-color`, { method: 'PATCH', body }); }
                        catch { await MA.api.api(`/dm/conversations/${cid}/colors/me`, { method: 'PATCH', body }); }
                    }
                } catch { }

                // Local optimistic update
                try {
                    const cm = MA.api?.getColorMap?.(cid) || null;
                    let cmap = cm instanceof Map
                        ? new Map(cm) // clone
                        : new Map(Object.entries(cm || {}).map(([k, v]) => [Number(k) || k, v]));

                    if (toSet) cmap.set(me, toSet); else cmap.delete(me);

                    // If your API expects a Map:
                    MA.api?.setColorMap?.(cid, cmap);

                    // If your API expects a plain object, convert:
                    const obj = Object.fromEntries(cmap);
                    MA.api?.setColorMapObj?.(cid, obj)

                    // repaint borders immediately
                    if (MA.utils?.updateAllMessageBorders) MA.utils.updateAllMessageBorders();
                    else if (global.updateAllMessageBorders) global.updateAllMessageBorders();
                    try { MA.refreshMessageActions?.(); } catch { }
                } catch { }
            },
            getContext: () => {
                const det = MA.state?.currentConvDetail || {};
                const me = MA.state?.me || {};
                return {
                    isGroup: !!det.is_group,
                    meId: MA.state?.meId || 0,
                    meName: me.display_name || me.username || 'Me',
                    mePhoto: me.profile_photo || ''
                };
            },
            DEFAULT_PFP_DM
        });

        MA.myColorOverlay = mc;              // app handle
        UI.myColor = mc;                      // namespaced instance
        UI.provide?.('myColor', mc);          // optional hub method
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installDefaultWiring, { once: true });
    } else {
        installDefaultWiring();
    }
})(typeof window !== 'undefined' ? window : globalThis);
