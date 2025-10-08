// web/reactions.js
(() => {
    const NS = (window.MessagesApp ||= {});
    const { api } = (NS.api ||= {});
    const { $, esc, nearBottom, afterPaint, scrollToBottom } = NS.utils;

    const MAX_RECENTS = 10;

    // Tiny fallback emoji list (searchable by short names).
    const EMOJI_CATALOG = [
        { k: '😀', n: 'grinning' }, { k: '😁', n: 'beaming' }, { k: '😂', n: 'joy' },
        { k: '🤣', n: 'rofl' }, { k: '😊', n: 'smile' }, { k: '😍', n: 'heart eyes' },
        { k: '😘', n: 'kiss' }, { k: '😜', n: 'winky tongue' }, { k: '🤔', n: 'thinking' },
        { k: '🤷', n: 'shrug' }, { k: '👏', n: 'clap' }, { k: '👍', n: 'thumbs up' },
        { k: '👎', n: 'thumbs down' }, { k: '🙏', n: 'pray' }, { k: '🔥', n: 'fire' },
        { k: '✨', n: 'sparkles' }, { k: '🎉', n: 'tada' }, { k: '💯', n: '100' },
        { k: '❤️', n: 'heart' }, { k: '😮', n: 'surprised' }, { k: '😢', n: 'cry' },
        { k: '😡', n: 'angry' }
    ];

    // Local state for this module only
    const RSTATE = {
        // message_id -> { key -> {kind, key, unicode, custom_id, count, users:Set, me:boolean} }
        byMsg: new Map(),
        // user libraries (cached per session)
        recent: [],              // array of reaction_key strings ('u:<emoji>' | 'c:<id>')
        customLib: [],           // [{id, name, url}]
        convId: 0,
    };

    /* -------------------------- helpers -------------------------- */

    const keyForEmoji = (u) => `u:${u}`;
    const keyForCustom = (id) => `c:${id}`;
    const isKeyCustom = (k) => k.startsWith('c:');
    const isKeyEmoji = (k) => k.startsWith('u:');

    function parseKey(k) {
        if (isKeyEmoji(k)) return { kind: 'emoji', unicode: k.slice(2) };
        if (isKeyCustom(k)) return { kind: 'custom', custom_emoji_id: +(k.slice(2)) };
        return { kind: 'emoji', unicode: k };
    }

    // Render a single chip (<button>) with count & highlight if me-reacted
    function chipHTML(entry) {
        const { key, kind, unicode, custom_id, count, me } = entry;
        const label = kind === 'emoji'
            ? esc(unicode)
            : `<img class="rx-img" src="${esc(entry.url || '')}" alt="${esc(entry.name || 'custom')}" />`;
        return `
      <button type="button"
              class="rx-chip ${me ? 'me' : ''}"
              data-rk="${esc(key)}"
              title="${esc(entry.name || '')}">
        <span class="rx-lab">${label}</span>
        <span class="rx-ct">${count | 0}</span>
      </button>`;
    }

    function ensureBarForMessage(container) {
        let bar = container.querySelector(':scope > .react-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'react-bar';
            container.appendChild(bar);
        }
        return bar;
    }

    function refreshBar(container, messageId) {
        const bar = ensureBarForMessage(container);
        const m = RSTATE.byMsg.get(messageId) || {};
        const arr = Object.values(m);
        if (!arr.length) { bar.innerHTML = ''; bar.style.display = 'none'; return; }
        bar.style.display = '';
        bar.innerHTML = arr
            .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
            .map(chipHTML).join('');
    }

    function bumpRecent(key) {
        // Keep uniqueness and recency (front of array is most recent)
        const next = [key, ...RSTATE.recent.filter(k => k !== key)];
        RSTATE.recent = next.slice(0, MAX_RECENTS);
        // fire-and-forget to server
        api('/dm/reactions/recents', { method: 'POST', body: { keys: RSTATE.recent } }).catch(() => { });
    }

    /* -------------------------- public API calls -------------------------- */

    async function fetchRecents() {
        try {
            const j = await api('/dm/reactions/recents');
            const keys = (j?.items || []).slice(0, MAX_RECENTS).map(String);
            RSTATE.recent = keys;
        } catch { RSTATE.recent = []; }
    }

    async function fetchCustomLib() {
        try {
            const j = await api('/dm/reactions/custom/library');
            const items = (j?.items || []).map(e => ({
                id: e.id, name: e.name || '', url: e.url || e.sprite || e.src || ''
            }));
            RSTATE.customLib = items;
        } catch { RSTATE.customLib = []; }
    }

    async function fetchMessageReactions(messageId) {
        // Load aggregated + me info
        try {
            const j = await api(`/dm/messages/${messageId}/reactions`);
            // Expect: items: [{reaction_key, kind, unicode, custom_emoji_id, count, me, name?, url?}]
            const map = {};
            for (const r of (j?.items || [])) {
                map[r.reaction_key] = {
                    key: r.reaction_key,
                    kind: r.kind,
                    unicode: r.unicode || null,
                    custom_id: r.custom_emoji_id || null,
                    name: r.name || null,
                    url: r.url || null,
                    count: r.count | 0,
                    me: !!r.me
                };
            }
            RSTATE.byMsg.set(messageId, map);
        } catch {
            RSTATE.byMsg.set(messageId, {});
        }
    }

    async function toggle(messageId, key) {
        const parsed = parseKey(key);
        const body = { reaction_key: key, ...parsed };
        let ok = false;

        try {
            // Try toggle endpoint first (idempotent)
            const j = await api(`/dm/messages/${messageId}/react/toggle`, {
                method: 'POST', body
            });
            ok = !!j?.ok;
        } catch {
            // Fallback to naive POST/DELETE probe
            try {
                await api(`/dm/messages/${messageId}/react`, { method: 'POST', body });
                ok = true;
            } catch {
                try { await api(`/dm/messages/${messageId}/react`, { method: 'DELETE', body }); ok = true; } catch { ok = false; }
            }
        }
        if (!ok) return;

        // Update local cache
        const msgMap = RSTATE.byMsg.get(messageId) || {};
        const existing = msgMap[key];
        if (existing?.me) {
            // unreact
            existing.me = false;
            existing.count = Math.max(0, (existing.count | 0) - 1);
            if (existing.count === 0) delete msgMap[key];
        } else if (existing) {
            existing.me = true;
            existing.count = (existing.count | 0) + 1;
        } else {
            // New chip local
            const e = {
                key,
                kind: parsed.kind,
                unicode: parsed.unicode || null,
                custom_id: parsed.custom_emoji_id || null,
                count: 1,
                me: true
            };
            // decorate custom with lib info if available
            if (e.kind === 'custom') {
                const found = RSTATE.customLib.find(x => x.id === e.custom_id);
                if (found) { e.name = found.name; e.url = found.url; }
            }
            msgMap[key] = e;
        }
        RSTATE.byMsg.set(messageId, msgMap);
        bumpRecent(key);
        // Notify chat.js (we update DOM in-place)
        const el = document.querySelector(`.msg[data-mid="${messageId}"]`);
        if (el) refreshBar(el, messageId);
    }

    /* -------------------------- Picker UI -------------------------- */

    function ensurePickerRoot() {
        let root = document.getElementById('rx-picker');
        if (root) return root;
        root = document.createElement('div');
        root.id = 'rx-picker';
        root.className = 'rx-overlay';
        root.innerHTML = `
      <div class="rx-panel">
        <div class="rx-head">
          <input id="rx-q" type="text" placeholder="Search emojis or paste any emoji…" />
          <button id="rx-close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="rx-sect rx-rec" data-collapsed="false">
          <div class="rx-sect-h">Recently used</div>
          <div class="rx-grid"></div>
        </div>
        <div class="rx-sect rx-custom" data-collapsed="false">
          <div class="rx-sect-h">Custom</div>
          <div class="rx-grid"></div>
          <div class="rx-custom-actions">
            <button id="rx-add-custom" type="button">＋ New custom</button>
          </div>
        </div>
        <div class="rx-sect rx-all" data-collapsed="false">
          <div class="rx-sect-h">Emojis</div>
          <div class="rx-grid"></div>
        </div>
      </div>`;
        document.body.appendChild(root);

        // collapse/expand
        root.addEventListener('click', (e) => {
            const h = e.target.closest('.rx-sect-h');
            if (!h) return;
            const sect = h.parentElement;
            const col = sect.getAttribute('data-collapsed') === 'true';
            sect.setAttribute('data-collapsed', String(!col));
        });
        root.querySelector('#rx-close').onclick = () => hidePicker();

        // search handler
        const q = root.querySelector('#rx-q');
        q.addEventListener('input', () => renderPickerContent()); // re-filters

        // add custom shortcut (hooks into your cropper later)
        root.querySelector('#rx-add-custom').onclick = () => {
            // You can replace this with your existing cropper and uploader
            // e.g., window.MessagesApp.openImageCropper(...)
            if (typeof NS.reactions.openCustomCreator === 'function') {
                NS.reactions.openCustomCreator();
            } else {
                alert('TODO: wire custom emoji creator to NS.reactions.openCustomCreator');
            }
        };

        // close on outside click
        root.addEventListener('mousedown', (e) => {
            if (!e.target.closest('.rx-panel')) hidePicker();
        });

        return root;
    }

    let CURRENT_ANCHOR = null;
    let CURRENT_MSGID = 0;

    function hidePicker() {
        const root = document.getElementById('rx-picker');
        if (!root) return;
        root.style.display = 'none';
        CURRENT_ANCHOR = null;
        CURRENT_MSGID = 0;
    }

    function showPicker(anchorEl, messageId) {
        CURRENT_ANCHOR = anchorEl;
        CURRENT_MSGID = messageId;
        const root = ensurePickerRoot();
        renderPickerContent();
        root.style.display = 'block';

        // position near anchor (simple)
        const r = anchorEl.getBoundingClientRect();
        root.querySelector('.rx-panel').style.top = Math.max(10, window.scrollY + r.bottom + 8) + 'px';
        root.querySelector('.rx-panel').style.left = Math.max(10, window.scrollX + r.left - 40) + 'px';
    }

    function renderPickerContent() {
        const root = ensurePickerRoot();
        const q = root.querySelector('#rx-q').value.trim().toLowerCase();

        // RECENT
        const recGrid = root.querySelector('.rx-rec .rx-grid');
        recGrid.innerHTML = RSTATE.recent.map(k => {
            const d = parseKey(k);
            if (d.kind === 'emoji') {
                return `<button class="rx-it" data-rk="${esc(k)}">${esc(d.unicode)}</button>`;
            } else {
                const lib = RSTATE.customLib.find(x => x.id === d.custom_emoji_id);
                if (!lib) return '';
                return `<button class="rx-it rx-custom-it" data-rk="${esc(k)}" title="${esc(lib.name)}">
          <img src="${esc(lib.url)}" alt="${esc(lib.name)}">
        </button>`;
            }
        }).join('');

        // CUSTOM LIB
        const custGrid = root.querySelector('.rx-custom .rx-grid');
        const custItems = !q ? RSTATE.customLib : RSTATE.customLib.filter(e =>
            (e.name || '').toLowerCase().includes(q)
        );
        custGrid.innerHTML = custItems.map(e => `
      <button class="rx-it rx-custom-it" data-rk="${esc(keyForCustom(e.id))}" title="${esc(e.name)}">
        <img src="${esc(e.url)}" alt="${esc(e.name)}">
      </button>`).join('');

        // ALL EMOJI
        const allGrid = root.querySelector('.rx-all .rx-grid');
        const all = !q
            ? EMOJI_CATALOG
            : EMOJI_CATALOG.filter(e => e.n.includes(q) || e.k.includes(q) || q.includes(e.k));
        allGrid.innerHTML = all.map(e => `<button class="rx-it" data-rk="${esc(keyForEmoji(e.k))}">${esc(e.k)}</button>`).join('');

        // item click (delegated)
        root.querySelectorAll('.rx-it').forEach(btn => {
            btn.onclick = async () => {
                const rk = String(btn.dataset.rk || '');
                if (!rk || !CURRENT_MSGID) return;
                await toggle(CURRENT_MSGID, rk);
                // close on pick
                hidePicker();
                // stick to bottom if user was there
                if (nearBottom(80)) { await afterPaint(); scrollToBottom(); }
            };
        });
    }

    /* -------------------------- public surface -------------------------- */

    async function attachBar(container, message) {
        // ensure marker for lookup
        container.dataset.mid = message.id;
        if (!RSTATE.byMsg.has(message.id)) await fetchMessageReactions(message.id);
        refreshBar(container, message.id);

        // click on existing chips toggles my reaction
        const bar = container.querySelector(':scope > .react-bar');
        if (!bar) return;
        bar.addEventListener('click', async (e) => {
            const btn = e.target.closest('.rx-chip'); if (!btn) return;
            const key = String(btn.dataset.rk || ''); if (!key) return;
            await toggle(message.id, key);
        });
    }

    function openPicker(anchorEl, message) {
        showPicker(anchorEl, message.id);
    }

    // SSE re-hydration hook
    function bindStream(es, convId) {
        RSTATE.convId = convId | 0;
        if (!es) return;
        es.addEventListener('reaction', (evt) => {
            try {
                // { message_id, reaction_key, delta, kind, unicode?, custom_emoji_id?, me?:bool, name?, url? }
                const d = JSON.parse(evt.data || '{}');
                const msgId = d.message_id | 0;
                if (!msgId) return;
                const map = RSTATE.byMsg.get(msgId) || {};
                const ex = map[d.reaction_key];
                if (ex) {
                    ex.count = Math.max(0, (ex.count | 0) + (d.delta | 0));
                    if ('me' in d) ex.me = !!d.me;
                    if (ex.count === 0) delete map[d.reaction_key];
                } else if ((d.delta | 0) > 0) {
                    map[d.reaction_key] = {
                        key: d.reaction_key, kind: d.kind,
                        unicode: d.unicode || null, custom_id: d.custom_emoji_id || null,
                        name: d.name || null, url: d.url || null,
                        count: d.delta | 0, me: !!d.me
                    };
                }
                RSTATE.byMsg.set(msgId, map);
                const el = document.querySelector(`.msg[data-mid="${msgId}"]`);
                if (el) refreshBar(el, msgId);
            } catch { }
        });
    }

    // Expose
    NS.reactions = {
        // UI
        attachBar, openPicker, bindStream,
        // optionally wire this to your cropper/uploader
        openCustomCreator: null,
        // bootstrap caches
        async init() { await Promise.allSettled([fetchRecents(), fetchCustomLib()]); }
    };

    // basic styles (minimal; extend in your css)
    const css = document.createElement('style');
    css.textContent = `
  .react-bar{display:flex;gap:.25rem;margin-top:.25rem;flex-wrap:wrap}
  .rx-chip{display:inline-flex;align-items:center;gap:.35rem;border:1px solid var(--border);
    background: var(--bg-2);border-radius:9999px;padding:.1rem .5rem;cursor:pointer}
  .rx-chip.me{outline:2px solid var(--accent, #6cf)}
  .rx-img{width:1.05rem;height:1.05rem;object-fit:cover;vertical-align:middle}
  .rx-overlay{position:fixed;inset:0;display:none;background:rgba(0,0,0,.15);z-index:1000}
  .rx-panel{position:absolute;background:var(--bg, #111);color:var(--fg,#eee);border:1px solid var(--border,#333);
    border-radius:.75rem;box-shadow:0 10px 30px rgba(0,0,0,.5);padding:.75rem;min-width:280px;max-width:420px}
  .rx-head{display:flex;gap:.5rem;align-items:center;margin-bottom:.5rem}
  #rx-q{flex:1; padding:.45rem .6rem; border:1px solid var(--border); background:var(--bg-2,#181818); color:inherit; border-radius:.5rem}
  #rx-close{border:0;background:transparent;color:inherit;font-size:1rem;cursor:pointer}
  .rx-sect{margin:.35rem 0}
  .rx-sect-h{font-size:.85rem;opacity:.8;cursor:pointer;margin-bottom:.25rem}
  .rx-sect[data-collapsed="true"] .rx-grid{display:none}
  .rx-grid{display:flex;flex-wrap:wrap;gap:.25rem}
  .rx-it{font-size:1.15rem;line-height:1;border:1px solid var(--border);background:var(--bg-2);border-radius:.5rem;padding:.25rem .4rem;cursor:pointer}
  .rx-custom-it{padding:.1rem}
  .rx-custom-it img{width:1.35rem;height:1.35rem;object-fit:cover;display:block}
  .rx-custom-actions{margin-top:.25rem}
  .rx-custom-actions button{border:1px solid var(--border);background:var(--bg-2);color:inherit;border-radius:.35rem;padding:.25rem .5rem;cursor:pointer}
  .msg-actions{display:flex;gap:.35rem; align-items:center; margin-top:.25rem}
  .msg-actions .react-btn{border:0;background:transparent;cursor:pointer;opacity:.85}
  .bubble-menu-btn{margin-left:auto}
  `;
    document.head.appendChild(css);

})();