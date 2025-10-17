// /web/messages/overlays.chat-menu.js
// Registers: ChatMenuUI (3-dots menu shell; handlers are injected by wiring.js)

(function (global) {
    'use strict';
    const UI = (global.UIOverlays = global.UIOverlays || {});

    const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

    class ChatMenuUI {
        /**
         * @param {Object} cfg
         * @param {HTMLElement} cfg.menuEl
         * @param {HTMLElement} cfg.buttonEl
         * @param {() => {isGroup:boolean,isOwner:boolean}} cfg.getContext
         * @param {Object<string,Function>} cfg.handlers
         */
        constructor({ menuEl, buttonEl, getContext, handlers = {} } = {}) {
            this.menu = menuEl || document.getElementById('chat-menu');
            this.btn = buttonEl || document.getElementById('chat-menu-btn');
            this.getContext = getContext || (() => ({ isGroup: false, isOwner: false }));
            this.cfg = { handlers };
            this._wire();
        }

        _wire() {
            if (!this.menu || !this.btn) return;
            if (this.menu.__cmWired) return; // idempotent
            this.menu.__cmWired = true;

            on(this.btn, 'click', (e) => { e.stopPropagation(); this.toggle(); });

            // Outside click closes (guard nulls)
            this._docClick = (e) => {
                const t = e.target;
                if (!this.menu || !this.btn) return;
                if (!this.menu.contains(t) && !this.btn.contains(t)) this.hide();
            };
            document.addEventListener('click', this._docClick);
        }

        hide() {
            if (this.menu) this.menu.style.display = 'none';
        }

        toggle() {
            if (!this.menu) return;
            if (this.menu.style.display === 'block') this.hide();
            else { this.render(); this.menu.style.display = 'block'; }
        }

        render() {
            if (!this.menu) return;
            const { isGroup, isOwner } = this.getContext();
            const items = [];

            if (isGroup) {
                // owner can manage, otherwise view only
                if (isOwner) {
                    // removed: Rename group
                    items.push({ id: 'manage', label: 'Manage members' });
                } else {
                    items.push({ id: 'view-members', label: 'View members' });
                }

                // NEW unified entry
                items.push({ id: 'chat-settings', label: 'Chat settings' });

                // removed per your request:
                // items.push({ id: 'restyle', label: 'Restyle Group' });
                items.push({ id: 'my-color', label: 'My Message Color' });
                items.push({ id: 'leave', label: 'Leave group' });
                items.push({ id: 'block-group', label: 'Block this group' });
            } else {
                // DM
                items.push({ id: 'chat-settings', label: 'Chat settings' });
                items.push({ id: 'delete-dm', label: 'Delete chat (for me)' });
                items.push({ id: 'block-user', label: 'Block user' });
            }

            this.menu.innerHTML = items
                .map(i => `<div class="item" data-id="${i.id}">${i.label}</div>`)
                .join('');

            this.menu.querySelectorAll('.item').forEach(el => {
                el.onclick = () => {
                    const id = el.dataset.id;
                    this.hide();
                    const h = this.cfg.handlers || {};
                    ({
                        'chat-settings': h.chatSettings,   // <— NEW
                        'settings': h.chatSettings,        // <— tolerate older id if present
                        'manage': h.manage,
                        'view-members': h.viewMembers,
                        // 'restyle': h.restyle,            // removed
                        'my-color': h.myColor,
                        'leave': h.leave,
                        'block-group': h.blockGroup,
                        'delete-dm': h.deleteDm,
                        'block-user': h.blockUser,
                    }[id] || (() => { }))();
                };
            });
        }
    }

    // Robust exports to avoid "not a constructor"
    UI.ChatMenuUI = ChatMenuUI;                               // namespaced
    if (!global.ChatMenuUI) global.ChatMenuUI = ChatMenuUI;   // global convenience
    UI.provide?.('ChatMenuUI', ChatMenuUI);                   // optional hub helper

})(typeof window !== 'undefined' ? window : globalThis);
