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

    const GROUPS = window.MessagesApp.groups || null;
    const CORE = window.MessagesApp || {};
    const U = CORE.utils || {};

    function coreComputeGroupTitleFromMembers(members) {
        if (GROUPS?.computeMemberListTitle) return GROUPS.computeMemberListTitle(members);
        if (typeof computeDefaultGroupTitle === 'function') return computeDefaultGroupTitle(members);
        return _titleFromMembers(members); // final fallback
    }

    // Returns a color the server/UI will accept.
    // Try a core/utility normalizer first; else pick from GROUP_COLORS safely.
    function corePickGroupColor(want) {
        try {
            if (U?.pickGroupColor) return U.pickGroupColor(want); // already returns hex, honors 'want'
            if (U?.normalizeGroupColor) {
                const hex = U.normalizeGroupColor(want);
                if (hex) return hex; // normalized key/hex -> hex
            }
        } catch { /* ignore */ }

        const pal = Array.isArray(GROUP_COLORS) ? GROUP_COLORS : [];
        const hexes = pal
            .map(c => (c && (c.val || c.hex || c.color || c)))
            .map(v => (v ? String(v) : null))
            .filter(Boolean);

        return hexes.length ? hexes[(Math.random() * hexes.length) | 0] : '#3b82f6';
    }

    // === groups: helpers + debug ==========================
    const _isGenericGroupTitle = (s) => {
        const t = String(s || '').trim().toLowerCase();
        return !t || t === 'group' || t === 'new group' || t === 'untitled group';
    };

    const _titleFromMembers = (members) => {
        const me = (state.meId | 0);
        const flat = (members || []).map(m => m?.user || m).filter(Boolean);
        const names = flat
            .filter(u => ((u.id | 0) !== me))
            .map(u => (pickName(u) || u?.username || u?.first_username || 'user'))
            .map(s => String(s).replace(/^@+/, '').trim())
            .filter(Boolean);

        if (names.length === 0) return 'Group';
        if (names.length === 1) return names[0];
        if (names.length === 2) return `${names[0]} & ${names[1]}`;
        return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
    };

    // === NEW: make a title that INCLUDES the host's name ===
    function _titleFromMembersIncludingHost(members) {
        const meId = (state.meId | 0);
        const flat = (members || []).map(m => m?.user || m).filter(Boolean);

        const nameFor = (u) => {
            // prefer pickName; fall back to usernames
            const n = pickName(u) || u?.display_name || u?.first_username || u?.username || '';
            return String(n).replace(/^@+/, '').trim();
        };

        // host (me) first if present, then others
        const meUser = flat.find(u => ((u.id | 0) === meId));
        const meName = meUser ? nameFor(meUser) : (window.MessagesApp?.me?.display_name || 'Me');

        const others = flat.filter(u => ((u.id | 0) !== meId)).map(nameFor).filter(Boolean);

        const names = (meName ? [meName] : []).concat(others);
        const uniq = Array.from(new Set(names)).filter(Boolean);

        if (!uniq.length) return 'Group';
        if (uniq.length === 1) return uniq[0];
        if (uniq.length === 2) return `${uniq[0]} & ${uniq[1]}`;
        return `${uniq.slice(0, -1).join(', ')} & ${uniq[uniq.length - 1]}`;
    }

    console.debug('[dm-ui] groups module present?', !!(window.MessagesApp?.groups));

    // Use the real groups module if present; otherwise, fall back to local API calls.
    const GROUPS_SAFE = (() => {
        if (window.MessagesApp?.groups?.create && window.MessagesApp?.groups?.renameToMembers) {
            return window.MessagesApp.groups;
        }

        async function create(userIds, opts = {}) {
            if (!Array.isArray(userIds) || userIds.length < 2) {
                throw new Error('fallback groups.create: need >= 2 userIds');
            }
            const color = corePickGroupColor(opts.color);
            console.debug('[groups-fallback] POST /dm/conversations', { userIds, color });
            const res = await api(`/dm/conversations`, { method: 'POST', body: { user_ids: userIds, color } });
            const cid = res?.conversation_id || res?.id;
            if (!cid) throw new Error('fallback groups.create: server returned no id');

            let conv = await api(`/dm/conversations/${cid}`, { method: 'GET' });
            const members = conv?.members || conv?.users || conv?.participants || [];
            const desired = coreComputeGroupTitleFromMembers(members);
            const serverTitle = (conv?.title || '').trim();

            const title = _isGenericGroupTitle(serverTitle) ? desired : serverTitle;
            return { id: cid, conversation: conv, title, color: conv?.color || color || null };
        }

        async function renameToMembers(conversationId) {
            const conv = await api(`/dm/conversations/${conversationId}`, { method: 'GET' });
            const serverTitle = (conv?.title || '').trim();
            const desired = coreComputeGroupTitleFromMembers(conv?.members || []);
            const newTitle = _isGenericGroupTitle(serverTitle) ? desired : serverTitle;
            try {
                const prev = state.convMeta?.get?.(conversationId) || {};
                state.convMeta?.set?.(conversationId, { ...prev, name: newTitle, auto_title: true, is_group: true });
                scheduleSaveMeta?.();
            } catch { /* ignore */ }
            return newTitle;
        }

        return { create, renameToMembers, computeMemberListTitle: coreComputeGroupTitleFromMembers };
    })();

    // Helpers used across
    (function ensureMsgActionStyles() {
        // Always (re)write the stylesheet so hot-reloads pick up changes.
        let st = document.getElementById('dm-msg-actions-styles');
        if (!st) {
            st = document.createElement('style');
            st.id = 'dm-msg-actions-styles';
            document.head.appendChild(st);
        }
        st.textContent = `
/* ===== DM actions & picker — FINAL OVERRIDES (merged) ===== */

/* Rail buttons: never change on hover/focus */
.react-btn,
.bubble-menu-btn{
  box-sizing:border-box; width:100%; height:28px; padding:0 8px;
  border:2px solid var(--border,#e6e6e6); background:#0e1116; color:#fff;
  font-weight:700; line-height:1; cursor:pointer; border-radius:0 !important;
  box-shadow:0 1px 0 rgba(255,255,255,.12) inset;
}
.react-btn:hover,.react-btn:active,.react-btn:focus,
.bubble-menu-btn:hover,.bubble-menu-btn:active,.bubble-menu-btn:focus{
  background:#0e1116 !important; color:#fff !important; border-color:var(--border,#e6e6e6) !important;
  box-shadow:0 1px 0 rgba(255,255,255,.12) inset !important; outline:none !important; filter:none !important; transition:none !important;
}

/* Picker shell */
#rx-fallback-pop{ position:fixed; z-index:3000; }
#rx-fallback-pop.rx-rich{
  width:min(640px,96vw) !important;          /* wider overlay */
  max-width:96vw !important;
  max-height:min(70vh,560px) !important;
  padding:8px !important;
  overflow-y:auto !important;
  overflow-x:hidden !important;
  background:var(--bg);
  border:1px solid var(--border);
  box-shadow:0 8px 18px rgba(0,0,0,.35);
  border-radius:.4rem;
}

/* Subtree reset */
#rx-fallback-pop, #rx-fallback-pop *{
  box-sizing:border-box !important;
  min-width:0 !important;
}

/* Header: search (fills) + upload (fixed 36px) — stays on one row */
#rx-fallback-pop .rx-head{
  display:grid !important;
  grid-template-columns: minmax(0,1fr) 36px !important; /* search | icon */
  grid-template-areas: "search upload" !important;
  gap:8px !important;
  align-items:center !important;
  margin-bottom:8px !important;
}
#rx-fallback-pop .rx-head > *{ min-width:0 !important; }
#rx-fallback-pop .rx-head input[type="search"]{
  grid-area:search !important;
  height:34px !important; width:100% !important;
  padding:0 10px !important;
  border:2px solid var(--border,#e6e6e6) !important;
  background:#0e1116 !important; color:var(--text,#fff) !important;
  border-radius:0 !important;
}
#rx-fallback-pop .rx-head .rx-upload-btn{
  grid-area:upload !important;
  justify-self:end !important;
  width:36px !important; height:34px !important; padding:0 !important;
  display:grid !important; place-items:center !important;
  border:2px solid var(--border,#e6e6e6) !important;
  background:#0e1116 !important; color:var(--text,#fff) !important;
  border-radius:0 !important; line-height:1 !important;
}
#rx-fallback-pop .rx-head .rx-upload-btn svg{ display:block; }

/* Sections (no inner scrollbars) */
#rx-fallback-pop .rx-sections{
  display:flex !important; flex-direction:column !important;
  gap:8px !important; width:100% !important; overflow:visible !important;
}

/* Headings */
#rx-fallback-pop .rx-h1{ color:#fff !important; font-size:13px !important; font-weight:700 !important; margin:6px 2px 4px !important; }
#rx-fallback-pop .rx-h2{ color:rgba(255,255,255,.72) !important; font-size:11.5px !important; font-weight:600 !important; margin:6px 2px 2px !important; }

/* Emoji grids: fill overlay width (no ragged right edge) */
#rx-fallback-pop .rx-grid{
  display:grid !important;
  grid-auto-flow:row !important;
  /* columns expand to share leftover space while keeping square tiles */
  grid-template-columns: repeat(auto-fit, minmax(36px, 1fr)) !important;
  justify-items:stretch !important;
  align-items:stretch !important;
  gap:6px !important;
  width:100% !important;
  padding:2px !important;
  overflow:visible !important;
  max-height:none !important;
}

/* Tiles: perfect squares, no border until hover */
#rx-fallback-pop .rx-grid > .rx-tile,
#rx-fallback-pop .rx-grid > .rx-emo{
  aspect-ratio:1/1 !important; width:100% !important; height:auto !important;
  display:flex !important; align-items:center !important; justify-content:center !important;
  background:var(--panel,#0e1116) !important;
  border: var(--bw,2px) solid transparent !important;   /* even thickness; invisible at rest */
  border-radius:0 !important;
  -webkit-mask-image:none !important; mask-image:none !important; clip-path: inset(0 round 0) !important;
  cursor:pointer !important; user-select:none !important;
}
#rx-fallback-pop .rx-grid > .rx-tile:hover,
#rx-fallback-pop .rx-grid > .rx-emo:hover{
  border-color:#fff !important;                          /* white border on hover */
}

/* Emoji content sizing */
#rx-fallback-pop .rx-grid > .rx-tile img,
#rx-fallback-pop .rx-grid > .rx-emo img{
  width:72% !important; height:72% !important; max-width:none !important; max-height:none !important;
  object-fit:contain !important; border-radius:0 !important; image-rendering:-webkit-optimize-contrast;
}
#rx-fallback-pop .rx-grid > .rx-tile,
#rx-fallback-pop .rx-grid > .rx-emo{
  font-size:28px !important; line-height:1 !important;  /* for unicode emoji */
}

/* Kill legacy overrides that forced inner scrollbars/borders */
#rx-fallback-pop.rx-rich .rx-grid{ overflow:visible !important; max-height:none !important; }
#rx-fallback-pop.rx-rich .rx-tile{ border-color:transparent !important; }
#rx-fallback-pop.rx-rich .rx-emo{  border-color:transparent !important; }

/* Reaction chips always clickable and above content */
.msg .reactions{ position:relative !important; z-index:200 !important; }
.reactions .rx-chip{
  position:relative !important; z-index:201 !important; pointer-events:auto !important;
}
.reactions .rx-chip *{ pointer-events:none !important; }
.msg .hover-pad{ z-index:0 !important; }

/* Consistent reaction borders + "mine" state */
.rx-chip,.rx-pill{
  border-width:var(--bw,2px) !important; border-style:solid !important; border-color:var(--border,#e6e6e6) !important;
  box-shadow:0 1px 0 var(--soft,rgba(255,255,255,.12)) inset !important;
}
.reactions .rx-chip.active,
.reactions .rx-pill.active,
.reactions .rx-chip.is-mine,
.reactions .rx-pill.is-mine{
  background:#383838 !important; color:#fff !important; border-color:var(--border,#e6e6e6) !important;
}

/* Keep picker chrome borders uniform */
#rx-fallback-pop,
#rx-fallback-pop .rx-head input[type="search"],
#rx-fallback-pop .rx-head button{
  border-width:var(--bw,2px) !important;
}
/* FORCE: search (fills) + upload (fixed) on one row, upload on the RIGHT */
#rx-fallback-pop .rx-head{
  display:flex !important;
  align-items:center !important;
  gap:8px !important;
  flex-wrap:nowrap !important;        /* never drop to next line */
}

#rx-fallback-pop .rx-head input[type="search"]{
  flex:1 1 auto !important;           /* takes remaining space */
  min-width:0 !important;             /* allows shrinking so button fits */
  width:auto !important;              /* defeat any 100% that could push wrap */
}

#rx-fallback-pop .rx-head .rx-upload-btn{
  flex:0 0 36px !important;           /* fixed width */
  width:36px !important;
  height:34px !important;
  margin:0 !important;
  align-self:stretch !important;      /* aligns nicely with the input */
  justify-self:end !important;        /* in case grid rules leak in */
}
/* ===== FIX: make ALL emoji sections full-width + wrap later (no giant tiles) ===== */

/* Ensure every section & category block uses the full overlay width */
#rx-fallback-pop .rx-sections,
#rx-fallback-pop .rx-sections > *,
#rx-fallback-pop #rx-grid-recent,
#rx-fallback-pop #rx-grid-custom,
#rx-fallback-pop .rx-h2 + .rx-grid{
  inline-size:100% !important;
  max-inline-size:none !important;
  padding-inline:0 !important;
  margin-inline:0 !important;
}

/* Apply to ALL emoji grids, including category grids following headers */
#rx-fallback-pop .rx-grid,
#rx-fallback-pop .rx-h2 + .rx-grid{
  display:grid !important;
  /* Keep 36px tiles; allow one more column by tightening column gap */
  grid-template-columns: repeat(auto-fill, 36px) !important;
  grid-auto-rows: 36px !important;
  column-gap:4px !important;    /* was 6px — helps fit an extra column */
  row-gap:6px !important;
  justify-content:start !important;
  justify-items:stretch !important;
  padding:0 !important;         /* remove inner padding that stole a column */
  width:100% !important;
  max-width:none !important;
}

/* Lock tiles to 36×36 — cancel any responsive 1fr stretching */
#rx-fallback-pop .rx-grid > .rx-tile,
#rx-fallback-pop .rx-grid > .rx-emo{
  width:36px !important;
  height:36px !important;
  aspect-ratio:auto !important; /* cancels earlier aspect-ratio:1/1 responsive rule */
  border: var(--bw,2px) solid transparent !important;
  border-radius:0 !important;
  background: var(--panel,#0e1116) !important;
  cursor:pointer !important;
  user-select:none !important;
}

/* Hover border without layout shift */
#rx-fallback-pop .rx-grid > .rx-tile:hover,
#rx-fallback-pop .rx-grid > .rx-emo:hover{
  border-color:#fff !important;
}

/* Emoji images scale to the plate */
#rx-fallback-pop .rx-grid > .rx-tile img,
#rx-fallback-pop .rx-grid > .rx-emo img{
  width: calc(100% - (var(--bw,2px) * 2)) !important;
  height: calc(100% - (var(--bw,2px) * 2)) !important;
  max-width:none !important;
  max-height:none !important;
  object-fit:contain !important;
}

/* Safety: keep everything border-box */
#rx-fallback-pop, #rx-fallback-pop *{
  box-sizing:border-box !important;
  min-width:0 !important;
}
/* ==== Custom Reaction Uploader (inline sheet inside #rx-fallback-pop) ==== */
#rx-fallback-pop .rx-upload-sheet{
  position: absolute; inset: 8px;
  background: var(--bg, #0e1116);
  border: 1px solid var(--border,#e6e6e6);
  box-shadow: 0 10px 22px rgba(0,0,0,.45);
  border-radius: .4rem;
  display: grid; grid-template-rows: auto 1fr auto;
  z-index: 5;
}
#rx-fallback-pop .rx-upload-head{
  display:flex; align-items:center; justify-content:space-between;
  padding:10px 12px; border-bottom:1px solid var(--border,#e6e6e6);
}
#rx-fallback-pop .rx-upload-title{ font-weight:700; color:#fff; }
#rx-fallback-pop .rx-upload-close{
  background:#0e1116; color:#fff; border:2px solid var(--border,#e6e6e6);
  line-height:1; padding:2px 8px; cursor:pointer; border-radius:0;
}

#rx-fallback-pop .rx-upload-body{
  display:grid; gap:12px;
  grid-template-columns: minmax(280px, 1fr) minmax(220px, 280px);
  padding:12px;
}
#rx-fallback-pop .rx-stage-wrap{
  display:grid; grid-template-rows:auto 1fr; gap:8px; min-height:0;
}
#rx-fallback-pop .rx-canvas-wrap{
  position:relative; width:100%; aspect-ratio:1/1; border:1px solid var(--border,#e6e6e6);
  background:#000; display:grid; place-items:center; overflow:hidden;
}
#rx-fallback-pop canvas.rx-stage{ width:100%; height:100%; display:block; }
#rx-fallback-pop .rx-drop-hint{
  position:absolute; inset:0; display:grid; place-items:center;
  color:rgba(255,255,255,.66); pointer-events:none; font-size:12px;
}
#rx-fallback-pop .rx-stage-ctl{
  display:grid; gap:8px;
}
#rx-fallback-pop .rx-ctl-row{ display:grid; grid-template-columns:auto 1fr; gap:8px; align-items:center; }
#rx-fallback-pop .rx-ctl-row label{ color:#fff; font-size:12px; opacity:.85; }
#rx-fallback-pop .rx-ctl-row input[type="range"]{ width:100%; }

#rx-fallback-pop .rx-side{
  display:grid; align-content:start; gap:10px;
}
#rx-fallback-pop .rx-name-row label{ color:#fff; font-size:12px; opacity:.85; display:block; margin-bottom:4px; }
#rx-fallback-pop .rx-name-row input{
  width:100%; height:34px; padding:0 10px;
  border:2px solid var(--border,#e6e6e6); background:#0e1116; color:#fff; border-radius:0;
}
#rx-fallback-pop .rx-msg{ font-size:12px; min-height:16px; }
#rx-fallback-pop .rx-msg.err{ color:#ff8989; }
#rx-fallback-pop .rx-msg.ok{ color:#7bffb9; }

#rx-fallback-pop .rx-upload-foot{
  display:flex; justify-content:flex-end; gap:8px; padding:10px 12px;
  border-top:1px solid var(--border,#e6e6e6);
}
#rx-fallback-pop .rx-btn{
  background:#0e1116; color:#fff; border:2px solid var(--border,#e6e6e6);
  height:34px; padding:0 12px; border-radius:0; cursor:pointer; font-weight:700;
}
#rx-fallback-pop .rx-btn[disabled]{ opacity:.5; cursor:not-allowed; }
#rx-fallback-pop .rx-canvas-wrap.has-image .rx-drop-hint{ display:none; }
/* Hint overlays the canvas and is clickable when visible */
#rx-fallback-pop .rx-canvas-wrap{ position:relative; }
#rx-fallback-pop .rx-drop-hint{
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  border:2px dashed var(--border,#e6e6e6); color:var(--text,#fff);
  background:rgba(255,255,255,.02);
  cursor:pointer; user-select:none; text-align:center; padding:8px;
}
#rx-fallback-pop .rx-canvas-wrap.has-image .rx-drop-hint{ display:none; }
/* Range: square thumbs, flat track */
#rx-fallback-pop .rx-stage-ctl input[type="range"]{
  -webkit-appearance:none; appearance:none;
  width:100%; height:8px; background:#0e1116; border:2px solid var(--border,#e6e6e6);
  border-radius:0; outline:none;
}
#rx-fallback-pop .rx-stage-ctl input[type="range"]::-webkit-slider-thumb{
  -webkit-appearance:none; appearance:none;
  width:14px; height:14px; background:#fff; border:2px solid var(--border,#e6e6e6);
  border-radius:0; cursor:pointer; margin-top:-3px;
}
#rx-fallback-pop .rx-stage-ctl input[type="range"]::-moz-range-thumb{
  width:14px; height:14px; background:#fff; border:2px solid var(--border,#e6e6e6);
  border-radius:0; cursor:pointer;
}
#rx-fallback-pop .rx-stage-ctl input[type="range"]::-moz-range-track{
  height:8px; background:#0e1116; border:2px solid var(--border,#e6e6e6); border-radius:0;
}

/* Buttons: base + invert on hover */
#rx-fallback-pop .rx-upload-sheet .rx-btn{
  border:2px solid var(--border,#e6e6e6);
  background:#0e1116; color:#fff; border-radius:0; line-height:1; height:34px; padding:0 12px;
}
#rx-fallback-pop .rx-upload-sheet .rx-btn:hover,
#rx-fallback-pop .rx-upload-sheet .rx-btn:focus{
  background:#fff; color:#0e1116;
}
#rx-fallback-pop .rx-upload-sheet .rx-btn:disabled{
  opacity:.5; cursor:not-allowed; filter:none;
}
/* keep invert for all buttons EXCEPT the Clear button */
#rx-fallback-pop .rx-upload-sheet .rx-btn:not(.rx-clear):hover,
#rx-fallback-pop .rx-upload-sheet .rx-btn:not(.rx-clear):focus{
  background:#fff; color:#0e1116;
}

/* Clear: invert on hover ONLY; stay normal on focus/active */
#rx-fallback-pop .rx-upload-sheet .rx-btn.rx-clear:hover{
  background:#fff; color:#0e1116;
}
#rx-fallback-pop .rx-upload-sheet .rx-btn.rx-clear:focus,
#rx-fallback-pop .rx-upload-sheet .rx-btn.rx-clear:active{
  background:#0e1116; color:#fff;
}
/* Full-width hover pad sits behind the rail but above message content.
   It captures hover across the whole row, but we'll press-through on interaction. */
.msg .hover-pad{
  position:absolute; inset:0; left:-100vw; right:-100vw;
  background:transparent; pointer-events:auto !important; z-index:0 !important;
}

/* Keep the rail visible whenever the row is hovered, picker/menu is open, or content is focused. */
.msg.hover .msg-actions,
.msg.menu-open .msg-actions,
.msg.rx-open .msg-actions,
.msg:focus-within .msg-actions { display:flex !important; }
.audp .audp-btn { cursor: pointer; }

/* ——— show the rail on row hover/focus (no overlay needed) ——— */
.msg .msg-actions{
  position:absolute; top:50%; right:8px; transform:translateY(-50%);
  display:none; z-index:210; gap:6px; pointer-events:auto;
}
.msg:hover .msg-actions,
.msg.hover .msg-actions,       /* your existing JS wiring still works */
.msg.menu-open .msg-actions,
.msg.rx-open .msg-actions,
.msg:focus-within .msg-actions{ display:flex !important; }
/* Expand the message's hover hit-area horizontally so ⋮ doesn't disappear */
.msg { position: relative; }

/* Full-width invisible hover net that keeps the row “hovered” */
.msg > .hover-pad{
  position:absolute;
  /* tiny top/bottom tolerance so small vertical wobbles don't drop hover */
  top:-6px; bottom:-6px;

  /* extend well past the bubble left/right */
  left:-100vw; right:-100vw;

  background:transparent;
  pointer-events:auto;        /* becomes the event target in the gutters */
  z-index:0;                  /* sits behind all real content */
}

/* Ensure real content sits above the pad and stays clickable */
.msg > :not(.hover-pad):not(.msg-actions){
  position:relative;
  z-index:1;
}

/* Belt-and-suspenders: keep the rail shown if you hover the rail itself */
.msg .msg-actions:hover{ display:flex !important; }

/* === FINAL: Wide invisible hover field behind each message === */
.msg { position: relative; }

/* The hover pad: same height as the message, extends far left/right, sits behind content */
.msg > .hover-pad{
  display:block !important;
  position:absolute;
  top:-6px;                 /* small tolerance makes aiming forgiving */
  bottom:-6px;
  left:-100vw;              /* extend well beyond bubble */
  right:-100vw;
  background:transparent;
  pointer-events:auto !important;  /* catches hover in the gutters */
  z-index:0 !important;            /* behind all real content */
}

/* Ensure real content remains on top and clickable */
.msg > :not(.hover-pad):not(.msg-actions){
  position:relative;
  z-index:1;
}

/* Actions rail: shown whenever the row is hovered/focused or menus are open */
.msg .msg-actions{
  position:absolute; top:50%; right:8px; transform:translateY(-50%);
  display:none; z-index:210; gap:6px; pointer-events:auto;
}
.msg:hover .msg-actions,
.msg.hover .msg-actions,       /* JS wiring also sets .hover */
.msg.menu-open .msg-actions,
.msg.rx-open .msg-actions,
.msg:focus-within .msg-actions{ display:flex !important; }
/* --- Reaction chips: slightly taller + bigger visuals --- */
.reactions{ display:flex; flex-wrap:wrap; gap:6px !important; }
.reactions .rx-chip{
  position:relative !important;
  overflow:visible !important;            /* allow overlay to overflow */
  display:inline-flex !important;
  align-items:center !important;
  gap:6px !important;
  min-height:32px !important;             /* taller */
  padding:4px 10px !important;           /* a touch more breathing room */
  font-size:15px !important;             /* bigger unicode emoji/count */
  line-height:1 !important;
}
.reactions .rx-chip img{                 /* bigger custom emoji image */
  width:20px !important; height:20px !important; object-fit:contain !important;
}

/* --- Hover-only bookmark overlay (chips + picker tiles) --- */
.reactions .rx-chip .rx-bm,
#rx-fallback-pop .rx-tile .rx-bm{
  position:absolute !important;
  bottom:-6px !important;                 /* overflow a little outside */
  right:-6px !important;
  display:none !important;                /* only on hover */
  width:18px !important; height:18px !important;
  border:2px solid var(--border,#e6e6e6) !important;
  background:#0e1116 !important; color:#fff !important;
  border-radius:50% !important;
  line-height:14px !important; font-size:12px !important;
  box-shadow:0 1px 0 rgba(255,255,255,.12) inset !important;
  z-index:6 !important;
  place-items:center !important;
}

/* Show bookmark only when hovering the reaction */
.reactions .rx-chip:hover .rx-bm,
#rx-fallback-pop .rx-tile:hover .rx-bm{ display:grid !important; }

/* Let the overlay be clickable even though children are pointer-events:none */
.reactions .rx-chip *{ pointer-events:none !important; }
.reactions .rx-chip .rx-bm{ pointer-events:auto !important; }

/* Picker tiles need position context & overflow so the overlay can sit outside */
#rx-fallback-pop .rx-grid > .rx-tile{
  position:relative !important; overflow:visible !important;
}

/* --- Reaction chips: slightly taller + bigger visuals --- */
.reactions{ display:flex; flex-wrap:wrap; gap:8px !important; }
.reactions .rx-chip{
  position:relative !important;
  overflow:visible !important;            /* allow overlay to overflow */
  display:inline-flex !important;
  align-items:center !important;
  gap:6px !important;
  min-height:32px !important;             /* taller */
  padding:4px 4px !important;            /* breathing room */
  font-size:22px !important;              /* bigger unicode emoji/count */
  line-height:1 !important;
}
.reactions .rx-chip img{                  /* bigger custom emoji image */
  width:30px !important; height:30px !important; object-fit:contain !important;
}

/* --- Hover-only bookmark overlay (chips + picker tiles) --- */
.reactions .rx-chip .rx-bm,
#rx-fallback-pop .rx-tile .rx-bm{
  position:absolute !important;
  bottom:-6px !important;                 /* overflow a little outside */
  right:-6px !important;
  display:none !important;                /* only on hover */
  width:18px !important; height:18px !important;
  border:2px solid var(--border,#e6e6e6) !important;
  background:#0e1116 !important; color:#fff !important;
  border-radius:50% !important;
  line-height:14px !important; font-size:12px !important;
  box-shadow:0 1px 0 rgba(255,255,255,.12) inset !important;
  z-index:6 !important;
  place-items:center !important;
}

/* Show bookmark only when hovering the reaction */
.reactions .rx-chip:hover .rx-bm,
#rx-fallback-pop .rx-tile:hover .rx-bm{ display:grid !important; }

/* Let the overlay be clickable even though children are pointer-events:none */
.reactions .rx-chip *{ pointer-events:none !important; }
.reactions .rx-chip .rx-bm,
#rx-fallback-pop .rx-tile .rx-bm{ pointer-events:auto !important; }

/* Picker tiles need position context & overflow so the overlay can sit outside */
#rx-fallback-pop .rx-grid > .rx-tile{
  position:relative !important; overflow:visible !important;
}
.reactions .rx-chip{
  gap: 0px !important;          /* was 6px */
}

/* (optional) trim any stray inner margins authors might add later */
.reactions .rx-chip > *{
  margin-left: 0 !important;
}

/* Ultra-tighten reaction → count spacing */
.reactions .rx-chip{ 
  gap: 0 !important; 
  --rx-tuck: 4px;                 /* tweak: 2–6px */
}

/* Pull the count left a bit (ignore the absolute bookmark button) */
.reactions .rx-chip > :not(.rx-bm) + :not(.rx-bm){
  margin-left: calc(var(--rx-tuck) * -1) !important;
}

/* Kill any inline whitespace around custom-emoji imgs */
.reactions .rx-chip img{ display:block !important; }

/* Tighten emoji → count, compensating for emoji font sidebearings */
.reactions .rx-chip{
  gap:0 !important;
  --rx-nudge: 0.34em;                  /* tweak: 0.28–0.40em */
}

/* Default: move the count left */
.reactions .rx-chip > :not(.rx-bm) + :not(.rx-bm){
  transform: translateX(calc(var(--rx-nudge) * -1)) !important;
  letter-spacing: -0.01em;             /* tiny kerning to keep multi-digit tight */
}

/* Kill inline-img whitespace so it doesn’t add phantom gap */
.reactions .rx-chip img{ display:block !important; line-height:1 !important; }

/* Kill any built-in gap first */
.reactions .rx-chip{
  gap:0 !important;
  white-space:nowrap !important;
}

/* CUSTOM EMOJI (IMG): pull the text node (count) left by nudging the image's margin */
.reactions .rx-chip > img,
.reactions .rx-chip > .rx-emo > img{
  display:block !important;           /* removes inline-img phantom spacing */
  margin-right:6px !important;       /* tweak: -4 to -8px */
}

/* UNICODE EMOJI (font): trim the sidebearing + any literal space in the markup */
.reactions .rx-chip{
  word-spacing:-0.30em !important;    /* collapses an actual space character */
  letter-spacing:-0.02em !important;  /* tiny global tighten to fight sidebearing */
}

/* If your count IS wrapped (sometimes it is), keep its digits readable */
.reactions .rx-chip .rx-count,
.reactions .rx-chip .count,
.reactions .rx-chip > :last-child{
  letter-spacing:0 !important;
}

/* Option A: simplest — give the chip a bit more breathing room on the right */
.reactions .rx-chip{
  padding-inline-end: 7px !important;   /* = padding-right in LTR */
}

/* Option B: bulletproof — add a tiny flex spacer after the content */
.reactions .rx-chip::after{
  content: "";
  display: block;
  flex: 0 0 4px;   /* width of the inner gap */
  height: 1px;     /* keeps it from collapsing in some engines */
}

/* Unify visual box for BOTH custom (IMG) and normal (unicode) emoji */
.reactions .rx-chip {
  display: inline-flex !important;
  align-items: center !important;
  gap: 4px !important;                 /* tight gap to the count */
  padding-inline-end: 0px !important;  /* tiny inner gap on right */
}

/* The emoji box: same sizing whether it's an <img> or a text span */
.reactions .rx-chip img,
.reactions .rx-chip .rx-glyph{
  width: 30px !important;
  height: 30px !important;
  flex: 0 0 30px !important;           /* prevents stretch */
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  margin-inline-end: 12px !important;   /* teeny space before the number */
  line-height: 1 !important;
}

/* Tune unicode emoji inside the glyph box */
.reactions .rx-chip .rx-glyph{
  font-size: 24px !important;          /* scale to taste (24–28 works well) */
  font-family: "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",emoji,system-ui;
}

/* Keep custom emoji images crisp in the same box */
.reactions .rx-chip img{
  object-fit: contain !important;
}

/* Tighten right side after the number */
.reactions .rx-chip::after{
  content: none !important;   /* remove the 4px spacer */
  flex: 0 0 0 !important;
}

.reactions .rx-chip{
  --rx-pad-end: 2px;          /* tweak 0–3px to taste */
  padding-inline-end: var(--rx-pad-end) !important;
}

/* belt & suspenders: ensure nothing adds extra margin on the last child */
.reactions .rx-chip > :last-child{
  margin-inline-end: 0 !important;
}

/* optional micro-tuck if you still see a hairline of space */
.reactions .rx-chip .rx-count{
  margin-inline-end: -2px !important;  /* adjust -2px..0px */
}
`;
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
            const normalize = (c) => (U?.normalizeGroupColor ? U.normalizeGroupColor(c) : c);

            let meta = {
                name: 'Direct Message',
                photo: DEFAULT_PFP_DM,
                is_group: !!j.is_group,
                color: normalize(j.color || null) || (prev?.color ?? null)
            };

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
                const listTitle =
                    (GROUPS && GROUPS.computeMemberListTitle
                        ? GROUPS.computeMemberListTitle(members)
                        : computeDefaultGroupTitle(members));
                const serverTitle = (j.title || '').trim();
                meta.name = serverTitle || listTitle;
                meta.photo = j.photo || j.avatar || DEFAULT_PFP_GROUP;
                meta.color = normalize(j.color) || meta.color || null; // <— ensure hex
                meta.auto_title = _isGenericGroupTitle(serverTitle);
            } else {
                const asUser = (u) => (u && (u.user || u)) || null;

                const memberUsers = Array.isArray(j.members)
                    ? j.members.map(asUser)
                    : [];

                const rawOther =
                    asUser(j.other) ||
                    memberUsers.find(u => ((u?.id | 0) !== (state.meId | 0))) ||
                    null;

                const other = asUser(rawOther);

                // Prefer display name/username fallbacks if pickName yields empty
                const fallbackName =
                    (other?.display_name || other?.first_username || other?.username || '').replace(/^@+/, '').trim();

                meta.name = pickName(other) || fallbackName || meta.name || 'Direct Message';
                meta.photo = pickPhoto(other) || other?.profile_photo || DEFAULT_PFP_DM;

                // keep reaction/delete flags as you already do...
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

    function ensureConvInList(id, seed = {}) {
        id = id | 0; if (!id) return;
        if ((state.allConvs || []).some(c => ((c.id | 0) === id))) return;

        const normalize = (c) => (U?.normalizeGroupColor ? U.normalizeGroupColor(c) : c);

        const meta = state.convMeta.get(id) || {};
        const is_group = seed.is_group ?? !!meta.is_group;
        const title = seed.title || meta.name || (is_group ? 'Group' : 'Direct Message');
        const color = normalize(seed.color ?? meta.color ?? null) || null;

        const item = { id, is_group, title, preview: '', color };
        state.allConvs = [item, ...(state.allConvs || [])];
        state.convItems.set(id, item);

        state.filteredConvs = [...state.allConvs];
        renderConvs(state.filteredConvs);
    }

    function updateEverywhere(id) {
        const meta = state.convMeta.get(id); if (!meta) return;
        const row = state.convRowEls.get(id);
        if (row) setConvRowContent(row, meta, row.querySelector('.preview')?.textContent || '');
        if (state.convId === id) updateTopBar(meta);
    }

    function renderConvs(list) {
        const wrap = $('convs'); wrap.innerHTML = ''; state.convRowEls.clear();
        const normalize = (c) => (U?.normalizeGroupColor ? U.normalizeGroupColor(c) : c);
        list.forEach(it => {
            const row = document.createElement('div'); row.className = 'conv'; row.dataset.id = it.id;
            const defaultMeta = {
                name: (it.is_group ? (it.title || 'Group') : (it.title || 'Direct Message')),
                photo: it.is_group ? DEFAULT_PFP_GROUP : DEFAULT_PFP_DM,
                is_group: !!it.is_group,
                color: normalize(it.color || null) || null
            };
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

        const normalize = (c) => (U?.normalizeGroupColor ? U.normalizeGroupColor(c) : c);

        for (const it of state.allConvs) {
            if (!state.convMeta.has(it.id)) {
                let meta = {
                    name: it.is_group ? (it.title || 'Group') : 'Direct Message',
                    photo: it.is_group ? DEFAULT_PFP_GROUP : DEFAULT_PFP_DM,
                    is_group: !!it.is_group,
                    color: normalize(it.color || null) || null
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
        if (state.convId && !state.allConvs.some(c => ((c.id | 0) === (state.convId | 0)))) {
            const meta = state.convMeta.get(state.convId) || {};
            const is_group = !!meta.is_group;
            const title = meta.name || (is_group ? 'Group' : 'Direct Message');
            state.allConvs.unshift({ id: state.convId, is_group, title, preview: '', color: meta.color || null });
        }
        renderConvs(state.allConvs);
    }

    // Message row bubble menu (downloads)
    function closeAllBubbleMenus() {
        document.querySelectorAll('.bubble-menu').forEach(el => {
            el.dataset.open = '0';           // <-- mark closed
            el.style.display = 'none';
            el._detachReposition?.();
            portalClose(el, 'bubble-menu--portal');
        });
        const rx = document.getElementById('rx-fallback-pop');
        if (rx) {
            rx._detachReposition?.();
            portalClose(rx, 'rx-pop--portal');
            rx.remove();
        }
        document.querySelectorAll('.msg.menu-open').forEach(el => el.classList.remove('menu-open'));
        document.querySelectorAll('.msg.rx-open').forEach(el => el.classList.remove('rx-open'));
    }

    function portalOpen(el, portalClass) {
        if (el._portaled) return;
        el._portaled = { parent: el.parentNode || null, next: el.nextSibling || null };
        document.body.appendChild(el);
        if (portalClass) el.classList.add(portalClass);
    }

    function portalClose(el, portalClass) {
        const p = el && el._portaled;
        if (!p) return;
        try {
            if (p.parent && p.parent.isConnected) {
                if (p.next && p.next.parentNode === p.parent) p.parent.insertBefore(el, p.next);
                else p.parent.appendChild(el);
            } else {
                // original parent gone (virtualization / rerender) — just remove safely
                if (el.parentNode) el.parentNode.removeChild(el);
            }
        } finally {
            el._portaled = null;
            if (portalClass) el.classList.remove(portalClass);
        }
    }

    /* Hard guard: never overlap the left column */
    function leftPanelGuard() {
        const left = document.querySelector('.left');
        if (!left) return 8;
        const r = left.getBoundingClientRect();
        return Math.max(8, Math.round(r.right) + 8);
    }

    /* Soft guard: keep inside the messages viewport (no covering header/composer) */
    function msgsGuardRect() {
        const msgs = document.getElementById('msgs');
        const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
        const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);

        if (!msgs) {
            const minL = leftPanelGuard();
            return { top: 8, left: minL, right: vw - 8, bottom: vh - 8 };
        }

        const r = msgs.getBoundingClientRect();
        const minL = Math.max(leftPanelGuard(), r.left + 8);
        return {
            top: Math.max(8, r.top + 8),
            bottom: Math.min(vh - 8, r.bottom - 8),
            left: minL,
            right: Math.min(vw - 8, r.right - 8)
        };
    }

    function positionUnderAnchor(anchorBtn, popEl) {
        if (popEl.dataset.open !== '1') return; // <-- hard stop if not open

        // make measurable (safe to set because we know it's open)
        const prevDisp = popEl.style.display;
        const prevVis = popEl.style.visibility;
        popEl.style.position = 'fixed';
        popEl.style.display = 'block';
        popEl.style.visibility = 'hidden';

        const a = anchorBtn.getBoundingClientRect();
        const g = msgsGuardRect();
        const mw = popEl.offsetWidth || 220;
        const mh = popEl.offsetHeight || 120;

        let top = a.bottom + 8;
        if (top + mh > g.bottom) top = Math.max(g.top, g.bottom - mh);

        let left = a.right - mw;      // prefer below-left
        if (left < g.left) left = a.left; // flip to below-right if needed
        left = Math.max(g.left, Math.min(g.right - mw, left));

        popEl.style.left = Math.round(left) + 'px';
        popEl.style.top = Math.round(top) + 'px';
        popEl.style.transform = 'none';   // <<< NEW: kill stray transforms
        popEl.style.margin = '0';         // <<< NEW: kill stray margins
        popEl.style.visibility = 'visible';
    }

    function bindReposition(popEl, anchorBtn) {
        const fn = () => {
            if (popEl.dataset.open !== '1') return;  // <-- ignore when closed
            positionUnderAnchor(anchorBtn, popEl);
        };
        const msgs = document.getElementById('msgs');
        window.addEventListener('resize', fn, { passive: true });
        window.addEventListener('scroll', fn, { passive: true, capture: true });
        msgs && msgs.addEventListener('scroll', fn, { passive: true });
        popEl._detachReposition = () => {
            window.removeEventListener('resize', fn, { passive: true });
            window.removeEventListener('scroll', fn, { passive: true, capture: true });
            msgs && msgs.removeEventListener('scroll', fn, { passive: true });
            popEl._detachReposition = null;
        };
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

        if (reactionsEnabled == null) reactionsEnabled = true;

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

        // --- vertical rail ---
        let actions = root.querySelector(':scope > .msg-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'msg-actions';
            actions.dataset.forMsg = message.id;
            root.appendChild(actions);
        } else {
            actions.innerHTML = '';
        }

        const hasMenuItems = (atts.length > 0) || deletable;

        // Nothing to show at all? Remove the rail and bail.
        if (!canReact && !hasMenuItems) {
            actions.remove();
            return;
        }

        // ===== ORDER: ⋮ ON TOP, 🙂 UNDERNEATH =====

        // 1) ⋮ only when there’s something to do
        let menu = null;
        if (hasMenuItems) {
            const dotsBtn = document.createElement('button');
            dotsBtn.type = 'button';
            dotsBtn.className = 'bubble-menu-btn';
            dotsBtn.textContent = '⋮';
            dotsBtn.setAttribute('aria-label', 'Message menu');
            dotsBtn.setAttribute('aria-haspopup', 'menu');
            dotsBtn.setAttribute('aria-expanded', 'false');
            actions.appendChild(dotsBtn); // appended FIRST so it's above the reaction button

            menu = document.createElement('div');
            menu.className = 'bubble-menu';
            menu.setAttribute('role', 'menu');
            menu.tabIndex = -1; // focusable container for Escape handling

            const parts = [];
            if (atts.length) {
                parts.push(...atts.map(a => {
                    const href = `${API}/dm/attachments/${a.id}/download`;
                    const filename = esc(a.filename || 'attachment');
                    return `<div class="item" role="none"><a role="menuitem" href="${href}" download="${filename}">Download ${filename}</a></div>`;
                }));
            }
            if (deletable) {
                parts.push(`<div class="item" role="none"><a role="menuitem" href="#" class="msg-del-link">Delete message</a></div>`);
            }
            menu.innerHTML = parts.join('');
            actions.appendChild(menu);

            function openMenu() {
                if (!hasMenuItems) return;
                closeAllBubbleMenus();
                portalOpen(menu, 'bubble-menu--portal');

                inheritTheme(dotsBtn.closest('.msg') || dotsBtn, menu);

                menu.style.position = 'fixed';
                menu.style.transform = 'none';
                menu.style.margin = '0';

                menu.dataset.open = '1';
                menu.style.display = 'block';
                root.classList.add('menu-open');
                dotsBtn.setAttribute('aria-expanded', 'true');

                positionUnderAnchor(dotsBtn, menu);
                bindReposition(menu, dotsBtn);

                // Move focus to the first actionable item for keyboard users
                const firstItem = menu.querySelector('[role="menuitem"]');
                (firstItem || menu).focus();
            }

            function closeMenu() {
                menu.dataset.open = '0';
                menu.style.display = 'none';
                root.classList.remove('menu-open');
                dotsBtn.setAttribute('aria-expanded', 'false');
                menu._detachReposition && menu._detachReposition();
                portalClose(menu, 'bubble-menu--portal');
                // restore focus to the trigger if it is still in the document
                if (document.contains(dotsBtn)) dotsBtn.focus();
            }

            // Toggle via click
            dotsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = menu.style.display === 'block';
                if (isOpen) closeMenu(); else openMenu();
            });

            // Toggle via keyboard (Enter/Space)
            dotsBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    dotsBtn.click();
                }
            });

            // Close on Escape when focus is inside the menu
            menu.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    closeMenu();
                }
            });

            // Fix downloads
            menu.querySelectorAll('a[download]').forEach(a => {
                const href = a.getAttribute('href') || '';
                const name = a.getAttribute('download') || 'attachment';
                window.MessagesApp.attachments?.fixDownloadLink?.(a, href, name, undefined);
            });

            // Delete handler
            const delLink = menu.querySelector('.msg-del-link');
            if (delLink) {
                delLink.addEventListener('click', async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    closeMenu();
                    try {
                        await window.MessagesApp.api.api(`/dm/messages/${message.id}`, { method: 'DELETE' });
                        const metaEl = root.querySelector(':scope > .meta');
                        root.classList.add('deleted');
                        root.innerHTML = `<div class="sysmsg-inner">Message deleted</div>`;
                        if (metaEl) root.appendChild(metaEl);
                    } catch (err) {
                        alert(window.MessagesApp.utils.errMsg(err));
                    }
                });
            }
        }

        // 2) 🙂 reaction button (only when allowed)
        if (canReact) {
            const rbtn = document.createElement('button');
            rbtn.type = 'button';
            rbtn.className = 'react-btn';
            rbtn.setAttribute('aria-label', 'React');
            rbtn.textContent = '🙂';
            const openPickerFromBtn = (e) => {
                e.stopPropagation();
                root.classList.add('rx-open');   // hides ⋮ via CSS while picker open
                window.MessagesApp.reactions?.openPicker?.(rbtn, message);
            };
            rbtn.onclick = openPickerFromBtn;
            rbtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openPickerFromBtn(e);
                }
            });
            actions.appendChild(rbtn); // appended SECOND so it sits below the dots
        }
    }

    // Close bubble menus on outside click
    document.addEventListener('click', (e) => {
        const inBubble = e.target.closest('.bubble-menu') || e.target.closest('.bubble-menu-btn');
        const inRx = e.target.closest('#rx-fallback-pop') || e.target.closest('.react-btn');
        if (inBubble || inRx) return;   // don't auto-close on react open or clicks inside picker
        closeAllBubbleMenus();
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

        // install a full-row hover pad so ⋮ never collapses while aiming
        if (!isSystem && !wrap.querySelector(':scope > .hover-pad')) {
            const hp = document.createElement('div');
            hp.className = 'hover-pad';
            hp.setAttribute('aria-hidden', 'true');
            wrap.insertBefore(hp, wrap.firstChild);
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
        ensureConvInList(id);
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
        state.es = es;

        const safeAfter = () => fetchAfter(state.lastMsgId).catch(() => { /* handled in fetchAfter */ });

        es.addEventListener('new', safeAfter);
        es.addEventListener('message', safeAfter);
        window.MessagesApp.reactions?.bindStream(es, id);

        // (optional) also guard errors: if server kills the stream on revoke, just drop silently
        es.onerror = () => { /* no-op; fetchAfter handler already handles terminal state */ };
    }
    // --- remove a conversation from the UI/state instantly ---
    function dropConversationRightNow(convId, reason = '') {
        convId = convId | 0;

        // 1) Kill the row in the left list immediately
        const row = state.convRowEls.get(convId);
        if (row && row.parentNode) row.parentNode.removeChild(row);
        state.convRowEls.delete(convId);

        // 2) Prune all local caches
        state.allConvs = (state.allConvs || []).filter(c => ((c.id | 0) !== convId));
        state.filteredConvs = (state.filteredConvs || []).filter(c => ((c.id | 0) !== convId));
        state.convItems.delete(convId);
        state.convMeta.delete(convId);
        state.convDetailById?.delete?.(convId);
        state.msgColorsByConv?.delete?.(convId);

        // 3) If it was open, close the view & stream and switch to the next convo if any
        if ((state.convId | 0) === convId) {
            try { state.es?.close?.(); } catch { }
            state.es = null;
            if (state.poll) { clearInterval(state.poll); state.poll = null; }

            // Reset the chat pane
            $('msgs').innerHTML = '<div id="pad-top"></div><div id="pad-bottom"></div>';
            state.renderedMsgIds?.clear?.();
            state.audioPlayers?.clear?.();
            state.lastMsgId = 0;
            state.oldestMsgId = null;
            state.nextBefore = null;

            // Pick a next chat if available
            const next = state.allConvs[0];
            state.convId = 0; // clear selection before we possibly open next
            if (next) {
                openConversation(next.id).catch(() => { });
            } else {
                // No conversations left — reset header/pfp
                $('chat-title').textContent = 'Direct Message';
                const pfp = $('chat-pfp');
                if (pfp) {
                    setImgSafe(pfp, DEFAULT_PFP_DM);
                    pfp.style.borderColor = 'var(--border)';
                    pfp.style.background = '#000';
                    pfp.classList.toggle('pixel', true);
                    pfp.classList.remove('tinted-default');
                }
            }
        }

        // Optional: refresh menu state
        try { window.MessagesApp.renderChatMenu?.(); } catch { }
    }

    async function ensureGroupHasSmartTitle(cid) {
        try {
            const j = await api(`/dm/conversations/${cid}`, { method: 'GET' });
            if (!j?.is_group) return;

            const normalize = (c) => (U?.normalizeGroupColor ? U.normalizeGroupColor(c) : c);

            const serverTitle = (j.title || '').trim();
            const serverColor = normalize(j.color) || null;

            const desiredTitle =
                (typeof _titleFromMembersIncludingHost === 'function')
                    ? _titleFromMembersIncludingHost(j.members || [])
                    : (typeof computeDefaultGroupTitle === 'function'
                        ? computeDefaultGroupTitle(j.members || [])
                        : 'Group');

            const needTitle = _isGenericGroupTitle(serverTitle);
            const needColor = !serverColor;

            if (!needTitle && !needColor) return;

            // Pick a default color if the server didn't assign one
            const targetColor = needColor ? (normalize(serverColor) || corePickGroupColor()) : serverColor;

            // Optimistic UI
            setConvMeta(cid, {
                name: needTitle ? desiredTitle : serverTitle,
                auto_title: needTitle,
                is_group: true,
                color: targetColor || serverColor || null
            });

            // Persist using only supported endpoints (or groups API if present)
            await setGroupNameAndColor(cid, {
                name: needTitle ? desiredTitle : undefined,
                color: needColor ? targetColor : undefined
            });
        } catch (e) {
            console.debug('[dm-ui] ensureGroupHasSmartTitle failed', cid, e);
        }
    }


    function openGlobalStream() {
        if (state.esGlobal) { try { state.esGlobal.close(); } catch { } }
        const es = new EventSource(`${API}/dm/stream`, { withCredentials: true });
        state.esGlobal = es;
        let reloadTimer = null;
        const scheduleConvsReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { loadConversations().catch(() => { }); }, 200); };

        es.addEventListener('conv_new', e => {
            try {
                const d = JSON.parse(e.data || '{}');
                const cid = d.conversation_id || d.id;
                if (cid) {
                    state.msgColorsByConv.delete(cid);
                    fetchConvMeta(cid).catch(() => { });
                    // NEW: if server left it as "Group", rename it to member list
                    ensureGroupHasSmartTitle(cid);
                }
            } catch { }
            scheduleConvsReload();
        });
        es.addEventListener('message', e => {
            const d = JSON.parse(e.data || '{}');
            if ((d.conversation_id | 0) !== (state.convId | 0)) scheduleConvsReload();
        });
        es.addEventListener('conv_meta', e => {
            const d = JSON.parse(e.data || '{}'); const cid = d.conversation_id | 0;
            const prev = state.convMeta.get(cid) || {};
            const normalize = (c) => (U?.normalizeGroupColor ? U.normalizeGroupColor(c) : c);
            const newPhoto = d.photo_ts ? `${API}/dm/conversations/${cid}/icon?ts=${encodeURIComponent(d.photo_ts)}` : prev.photo;
            const next = {
                ...prev,
                is_group: true,
                color: normalize(d.color) || prev.color || null,   // <— normalize to hex for UI
                photo: newPhoto || prev.photo
            };
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

        // --- NEW: instant removal/hide (no refresh needed) ---
        es.addEventListener('conv_removed', e => {
            try {
                const d = JSON.parse(e.data || '{}');
                const cid = d.conversation_id || d.id;
                if (cid) dropConversationRightNow(cid | 0, d.reason || 'removed');
            } catch { }
        });
        es.addEventListener('conv_hidden', e => {
            try {
                const d = JSON.parse(e.data || '{}');
                const cid = d.conversation_id || d.id;
                if (cid) dropConversationRightNow(cid | 0, d.reason || 'hidden');
            } catch { }
        });

        es.onerror = () => { /* keep silent; server will reconnect */ };
    }
    function startCatchup() { state.poll = setInterval(() => { fetchAfter(state.lastMsgId).catch(() => { }); }, 30000); }
    function _isForbidden(err) {
        const msg = (err && (err.message || err.detail || '') || '');
        return (err && (err.status === 403 || err.code === 403 || err?.response?.status === 403)) ||
            /forbidden/i.test(msg);
    }

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
            loadConversations().catch(() => { });
            // jumpBtn.sync() kept as-is
            jumpBtn.sync();
        } catch (e) {
            if (_isForbidden(e)) {
                // conversation is gone (blocked/hidden/left). Clean up quietly.
                dropConversationRightNow(state.convId, 'forbidden');
                return; // swallow expected error
            }
            // non-403: keep it quiet but visible in debug
            try { console.debug('[after] fetch failed', e); } catch { }
        } finally {
            state.fetchingAfter = false;
        }
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
                scheduleSaveMeta();
                ensureConvInList(cid, { is_group: false, title: meta.name, color: null });
                openConversation(cid);
            } else if (state.allConvs[0]) {
                openConversation(state.allConvs[0].id);
            }
        } catch (e) { alert(window.MessagesApp.utils.errMsg(e)); }
    }

    // === SET: group name + color (server + local UI) ==========================
    // REPLACE the old setGroupNameAndColor with this safe shim:
    async function setGroupNameAndColor(conversationId, { name, title, color } = {}) {
        const cid = conversationId | 0;
        if (!cid) throw new Error('setGroupNameAndColor: bad conversation id');

        const normalize = (c) => (U?.normalizeGroupColor ? U.normalizeGroupColor(c) : c);
        const wantTitle = String(name || title || '').trim();
        const wantColor = normalize(color || '');

        // Prefer the groups module if it exists (uses /title + /appearance under the hood)
        if (window.MessagesApp?.groups?.setTitleAndColor) {
            return await window.MessagesApp.groups.setTitleAndColor(cid, {
                title: wantTitle, color: wantColor
            });
        }

        // Fallback: call only endpoints that exist on your server
        const out = { id: cid };

        if (wantTitle) {
            await api(`/dm/conversations/${cid}/title`, { method: 'PATCH', body: { title: wantTitle } });
            out.title = wantTitle;
        }

        if (wantColor) {
            const fd = new FormData();
            fd.append('color', wantColor);
            await api(`/dm/conversations/${cid}/appearance`, { method: 'PATCH', body: fd });
            out.color = wantColor;
        }

        // Optimistic local UI update
        setConvMeta(cid, {
            name: wantTitle || undefined,
            is_group: true,
            color: wantColor || undefined,
            auto_title: wantTitle ? false : undefined
        });
        try { if ((state.convId | 0) === cid) updateTopBar(state.convMeta.get(cid)); } catch { }
        try { updateAllMessageBorders(); } catch { }

        return out;
    }

    // CHANGED: createGroupFromIds — now applies explicit name/color if provided
    async function createGroupFromIds(userIds, opts = {}) {
        if (!Array.isArray(userIds) || userIds.length < 2) {
            alert('Pick at least 2 people'); return;
        }
        try {
            const wantColor = corePickGroupColor(opts?.color);
            console.debug('[dm-ui] createGroupFromIds', { userIds, wantColor, via: (window.MessagesApp?.groups ? 'groups-module' : 'fallback') });

            const { id, title: serverTitle, color: serverColor, conversation } =
                await GROUPS_SAFE.create(userIds, { ...opts, color: wantColor });

            const normalize = (c) => (U?.normalizeGroupColor ? U.normalizeGroupColor(c) : c);

            const members = conversation?.members || conversation?.users || conversation?.participants || [];
            const desiredTitle = _titleFromMembersIncludingHost(members);
            const serverT = (conversation?.title || serverTitle || '').trim();

            // Pre-resolve what the server gave us
            const finalTitle = _isGenericGroupTitle(serverT) ? desiredTitle : (serverT || desiredTitle);
            const finalColor = normalize(conversation?.color || serverColor || wantColor) || '#3b82f6';
            const photo = conversation?.photo || DEFAULT_PFP_GROUP;

            // Seed immediately
            setConvMeta(id, { name: finalTitle, photo, is_group: true, color: finalColor, auto_title: true });
            ensureConvInList(id, { is_group: true, title: finalTitle, color: finalColor });

            // If caller supplied explicit name/color, enforce them on the server + UI
            const wantTitleRaw = String((opts?.name || opts?.title || '')).trim();
            const wantColorRaw = opts?.color;
            const wantColorNorm = wantColorRaw ? normalize(corePickGroupColor(wantColorRaw)) : null;

            if (wantTitleRaw || wantColorRaw) {
                const targetTitle = wantTitleRaw || finalTitle;
                const targetColor = wantColorNorm || finalColor;
                try {
                    await setGroupNameAndColor(id, { name: targetTitle, color: targetColor });
                } catch { /* even if server refuses, local UI is already set */ }
            }

            await openConversation(id);

            try {
                if (window.MessagesApp?.api?.randomizeMyMsgColor) {
                    await window.MessagesApp.api.randomizeMyMsgColor(id);
                } else {
                    // Fallback: hit the same endpoint directly
                    const randHex = () => '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
                    const color = randHex();
                    await api(`/dm/conversations/${id}/message_colors/me`, { method: 'PATCH', body: { color } });
                    await syncMsgColors(id, { retry: 1 });
                    window.MessagesApp.utils?.updateAllMessageBorders?.();
                    console.log('[dm-ui] my color ->', color);
                }
            } catch (err) {
                console.debug('[dm-ui] randomizeMyMsgColor failed (non-fatal)', err);
            }

            return id;
        } catch (e) {
            alert(window.MessagesApp.utils.errMsg(e));
            throw e;
        }
    }

    async function maybeAutoRenameGroup() {
        const det = state.currentConvDetail || state.convDetailById.get(state.convId) || {};
        if (!det?.is_group) return;
        const meta = state.convMeta.get(state.convId) || {};
        if (meta.auto_title === false) return; // user explicitly set a custom title

        try {
            const newTitle = await (GROUPS_SAFE.renameToMembers(state.convId));
            if (newTitle) setConvMeta(state.convId, { name: newTitle, auto_title: true });
        } catch { /* silent */ }
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

    function inheritTheme(fromEl, toEl) {
        try {
            const src = (fromEl && fromEl.nodeType === 1)
                ? fromEl
                : document.querySelector('#msgs') || document.documentElement;

            const cs = getComputedStyle(src);

            // Copy ALL custom properties (e.g., --bg, --bg-2, --border, --accent, etc.)
            for (let i = 0; i < cs.length; i++) {
                const name = cs[i];
                if (name.startsWith('--')) {
                    const val = cs.getPropertyValue(name);
                    if (val) toEl.style.setProperty(name, val);
                }
            }

            // Typography and foreground color so inputs/buttons match your app
            toEl.style.font = cs.font || `${cs.fontSize} ${cs.fontFamily}`;
            toEl.style.color = cs.color || 'inherit';
            toEl.style.setProperty('-webkit-font-smoothing',
                cs.getPropertyValue('-webkit-font-smoothing') || 'antialiased');
            toEl.style.setProperty('text-rendering',
                cs.getPropertyValue('text-rendering') || 'optimizeLegibility');
            toEl.style.boxSizing = 'border-box';
        } catch { }
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
                btn.dataset.rxKey = key || '';
                btn.setAttribute('aria-pressed', it.reacted_by_me ? 'true' : 'false');

                // — glyph box —
                if (it.kind === 'custom' && it.custom_emoji_id) {
                    const url = customUrlFor ? (customUrlFor(it.custom_emoji_id) || '') : '';
                    if (url) {
                        const img = new Image();
                        img.src = url;
                        img.alt = 'custom';
                        btn.appendChild(img); // styled by .rx-chip img rules
                    } else {
                        const g = document.createElement('span');
                        g.className = 'rx-glyph';
                        g.textContent = '★';
                        btn.appendChild(g);
                    }
                } else {
                    const g = document.createElement('span');
                    g.className = 'rx-glyph';
                    g.textContent = it.unicode || it.emoji || '⭐';
                    btn.appendChild(g);
                }

                // — count —
                const c = document.createElement('span');
                c.className = 'rx-count';
                c.textContent = String(it.count | 0);
                btn.appendChild(c);

                el.appendChild(btn);
            });
            // picker opens from the hover rail's 🙂 button; no “add” chip here
        }

        function normalizeReactionGlyphs(scopeEl) {
            const chips = scopeEl.querySelectorAll('.rx-chip');
            chips.forEach(chip => {
                const hasImg = !!chip.querySelector('img');
                const hasGlyph = !!chip.querySelector('.rx-glyph');
                if (!hasImg && !hasGlyph) {
                    const first = chip.firstChild;
                    if (first && first.nodeType === 3) {
                        const g = document.createElement('span');
                        g.className = 'rx-glyph';
                        g.textContent = first.nodeValue.trim();
                        chip.replaceChild(g, first);
                    } else if (first && first.nodeType === 1 && first.tagName !== 'IMG') {
                        first.classList.add('rx-glyph');
                    }
                }
                if (!chip.querySelector('.rx-count')) {
                    // find a trailing text node with digits and wrap it
                    const tailText = Array.from(chip.childNodes).find(n => n.nodeType === 3 && /\d/.test(n.nodeValue || ''));
                    if (tailText) {
                        const c = document.createElement('span');
                        c.className = 'rx-count';
                        c.textContent = (tailText.nodeValue || '').replace(/[^\d]/g, '').trim() || (tailText.nodeValue || '').trim();
                        chip.replaceChild(c, tailText);
                    }
                }
            });
        }

        class RichReactionPickerUI {
            constructor(opts) {
                this.opts = opts || {};
                this.recentKey = 'rx.recent.v1';
                this.recent = this._loadRecent();
                // Emoji source: allow host to inject a full list; fallback to a curated set.
                this.EMOJI = (window.MessagesApp && window.MessagesApp.EMOJI_FULL) || DEFAULT_EMOJI; // defined below
                this.cats = [...new Set(this.EMOJI.map(e => e.cat))];
            }

            _loadRecent() {
                try { return JSON.parse(localStorage.getItem(this.recentKey) || '[]').slice(0, 24); } catch { return []; }
            }
            _pushRecent(key) {
                try {
                    const arr = this._loadRecent().filter(k => k !== key);
                    arr.unshift(key);
                    localStorage.setItem(this.recentKey, JSON.stringify(arr.slice(0, 24)));
                    this.recent = arr.slice(0, 24);
                } catch { }
            }

            async _toggleBookmark(id, want) {
                try {
                    const tries = [
                        () => window.MessagesApp.api.api(`/dm/reactions/custom/${id}/bookmark`, { method: want ? 'POST' : 'DELETE', body: { save: !!want } }),
                        () => apiPost('/dm/reactions/custom/bookmark', { emoji_id: +id, save: !!want }),
                        () => apiPost('/dm/reactions/custom/bookmarks/toggle', { id: +id, save: !!want }),
                        () => apiPost('/dm/reactions/custom/library', { id: +id, bookmarked: !!want }),
                    ];
                    for (const t of tries) { try { await t(); break; } catch { } }
                } finally {
                    const set = _readSaved();
                    if (want) set.add(+id); else set.delete(+id);
                    _writeSaved(set);
                    const meta = LIB.get(+id); if (meta) meta.saved = !!want;
                    try { await refreshLibrary(); } catch { }
                }
            }

            async _openUploader() {
                // Prefer host overlay
                if (window.UIOverlays?.CustomEmojiUploadUI?.open) {
                    await window.UIOverlays.CustomEmojiUploadUI.open();
                    return;
                }
                // Fallback tiny uploader
                return new Promise((resolve) => {
                    const inp = document.createElement('input');
                    inp.type = 'file';
                    inp.accept = 'image/*';
                    inp.multiple = false;
                    inp.style.display = 'none';
                    document.body.appendChild(inp);
                    inp.onchange = async () => {
                        const f = inp.files && inp.files[0];
                        document.body.removeChild(inp);
                        if (!f) return resolve();
                        const fd = new FormData();
                        fd.append('image', f, f.name || 'custom-emoji');
                        try {
                            await window.MessagesApp.api.api('/dm/reactions/custom/upload', { method: 'POST', body: fd });
                        } catch (e) {
                            // Silently ignore (keep UI responsive)
                        }
                        resolve();
                    };
                    inp.click();
                });
            }

            _makeTile(payload, { saved, title, imgUrl, text }) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'rx-tile';
                btn.title = title || '';
                if (imgUrl) {
                    const img = document.createElement('img');
                    img.src = imgUrl;
                    img.alt = title || 'custom';
                    btn.appendChild(img);
                } else if (text) {
                    btn.textContent = text;
                    btn.style.fontSize = '20px';
                    btn.style.lineHeight = '1';
                }
                // Bookmark nub (only on custom; appears on hover)
                if (payload.kind === 'custom') {
                    const bm = document.createElement('div');
                    bm.className = 'rx-bm' + (saved ? ' saved' : '');
                    bm.title = saved ? 'Remove from favorites' : 'Save to favorites';
                    bm.textContent = saved ? '★' : '☆';
                    bm.addEventListener('click', async (e) => {
                        e.stopPropagation(); e.preventDefault();
                        const want = !saved;
                        try { await this._toggleBookmark(payload.custom_emoji_id, want); }
                        finally {
                            // reflect immediately; library refresh happens outside
                            saved = want;
                            bm.classList.toggle('saved', saved);
                            bm.textContent = saved ? '★' : '☆';
                            bm.title = saved ? 'Remove from favorites' : 'Save to favorites';
                        }
                    });
                    btn.appendChild(bm);
                }
                // Pick handler
                btn.addEventListener('click', async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    try {
                        await this.opts.toggleReaction(this._msgId, payload);
                        const key = payload.kind === 'emoji' ? `u:${payload.unicode}` : `c:${payload.custom_emoji_id}`;
                        this._pushRecent(key);
                        this.onPicked && this.onPicked(payload);
                    } catch { }
                    finally {
                        this._cleanup && this._cleanup();
                    }
                });
                return btn;
            }

            _renderCustom(grid, q, onlySaved) {
                const lib = Array.from(LIB.values() || []); // [{id,url,name,saved}]
                const items = lib.filter(e => {
                    if (onlySaved && !e.saved) return false;
                    if (!q) return true;
                    const need = q.toLowerCase();
                    return (e.name || '').toLowerCase().includes(need);
                });
                grid.innerHTML = '';
                if (!items.length) {
                    const empty = document.createElement('div'); empty.className = 'rx-empty';
                    empty.textContent = onlySaved ? 'No saved custom reactions yet.' : 'No matches.';
                    grid.appendChild(empty);
                    return;
                }
                items.forEach(e => {
                    const tile = this._makeTile({ kind: 'custom', custom_emoji_id: e.id }, {
                        saved: !!e.saved,
                        title: e.name || 'Custom',
                        imgUrl: e.url
                    });
                    grid.appendChild(tile);
                });
            }

            _renderEmoji(grid, q, cat) {
                let arr = this.EMOJI;
                if (cat && cat !== 'All') arr = arr.filter(e => e.cat === cat);
                if (q) {
                    const need = q.toLowerCase();
                    arr = arr.filter(e => (e.n || '').toLowerCase().includes(need) || e.u.includes(q));
                }
                grid.innerHTML = '';
                // Recent first (only when no query)
                // Recent first (only when no query)
                if (!q && this.recent.length) {
                    // remove any previous recent block
                    const prevWrap = grid.previousElementSibling;
                    if (prevWrap && prevWrap.classList && prevWrap.classList.contains('rx-recent-wrap')) {
                        prevWrap.remove();
                    }
                    const wrap = document.createElement('div'); wrap.className = 'rx-recent-wrap';
                    const title = document.createElement('div'); title.className = 'rx-title'; title.textContent = 'Recent';
                    const rGrid = document.createElement('div'); rGrid.className = 'rx-grid';
                    this.recent.forEach(k => {
                        const isCustom = k.startsWith('c:');
                        if (isCustom) {
                            const id = +k.slice(2); const meta = LIB.get(id);
                            if (!meta) return;
                            rGrid.appendChild(this._makeTile({ kind: 'custom', custom_emoji_id: id }, { saved: !!meta.saved, title: meta.name, imgUrl: meta.url }));
                        } else {
                            const uni = k.slice(2);
                            const e = this.EMOJI.find(x => x.u === uni);
                            if (e) rGrid.appendChild(this._makeTile({ kind: 'emoji', unicode: e.u }, { title: e.n, text: e.u }));
                        }
                    });
                    wrap.append(title, rGrid);
                    grid.parentNode.insertBefore(wrap, grid);
                } else {
                    // if there was a recent block and now we have a query, remove it
                    const prevWrap = grid.previousElementSibling;
                    if (prevWrap && prevWrap.classList && prevWrap.classList.contains('rx-recent-wrap')) {
                        prevWrap.remove();
                    }
                }
                if (!arr.length) {
                    const empty = document.createElement('div'); empty.className = 'rx-empty'; empty.textContent = 'No matches.';
                    grid.appendChild(empty);
                    return;
                }
                arr.forEach(e => {
                    const tile = this._makeTile({ kind: 'emoji', unicode: e.u }, { title: e.n, text: e.u });
                    grid.appendChild(tile);
                });
            }

            async open(msgId, anchorEl) {
                // remove old
                const old = document.getElementById('rx-fallback-pop');
                if (old) { old._detachReposition?.(); portalClose(old, 'rx-pop--portal'); old.remove(); }

                this._msgId = msgId;

                const pop = document.createElement('div');
                pop.id = 'rx-fallback-pop';
                pop.className = 'rx-pop--portal rx-rich';
                pop.dataset.open = '1';
                Object.assign(pop.style, {
                    position: 'fixed',
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    boxShadow: '0 8px 18px rgba(0,0,0,.35)',
                    borderRadius: '.4rem',
                    zIndex: '3000'
                });

                inheritTheme(anchorEl?.closest?.('.msg') || anchorEl || document.querySelector('#msgs') || document.documentElement, pop);

                // —— header: SEARCH + UPLOAD (no dropdowns)
                const head = document.createElement('div'); head.className = 'rx-head';
                const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search emoji & custom…';
                const uploadBtn = document.createElement('button');
                uploadBtn.type = 'button';
                uploadBtn.className = 'rx-upload-btn';
                uploadBtn.setAttribute('aria-label', 'Upload custom emoji');
                uploadBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3l4 4h-3v6h-2V7H8l4-4zm-7 14h14v2H5v-2z"/></svg>';
                uploadBtn.addEventListener('click', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    openUploaderSheet(); // ← inline editor, keeps picker open
                });
                head.append(search, uploadBtn);
                function openUploaderSheet() {
                    if (pop.querySelector('.rx-upload-sheet')) return;

                    const PNG_MIME = 'image/png';
                    const MAX_BYTES = 1 * 1024 * 1024;
                    const OUT_SIZE = 512;
                    const ZOOM_MIN_REL = 0.5;
                    const ZOOM_MAX_REL = 14.0;

                    const relFromNormalizedSlider = (t) => {
                        t = Math.max(0, Math.min(1, Number(t)));
                        if (t <= 0.5) { const u = t / 0.5; return ZOOM_MIN_REL * Math.pow(1 / ZOOM_MIN_REL, u); }
                        const u = (t - 0.5) / 0.5; return Math.pow(ZOOM_MAX_REL, u);
                    };

                    const RE_NAME = /^[A-Za-z0-9_]{4,16}$/;
                    const looksBanned = (raw) => {
                        const s = String(raw || '').toLowerCase();
                        try {
                            if (window.DP?.isBanned) return !!window.DP.isBanned(s);
                            if (window.USERNAME?.isBanned) return !!window.USERNAME.isBanned(s);
                            if (window.MessagesApp?.utils?.isBannedWord) return !!window.MessagesApp.utils.isBannedWord(s);
                            const list = window.USERNAME_BANNED || window.BANNED_WORDS || [];
                            return list.some(w => s.includes(String(w).toLowerCase()));
                        } catch { return false; }
                    };

                    const sheet = document.createElement('div');
                    sheet.className = 'rx-upload-sheet';
                    sheet.innerHTML = `
    <div class="rx-upload-head">
      <div class="rx-upload-title">New custom reaction</div>
      <button type="button" class="rx-upload-close">×</button>
    </div>
    <div class="rx-upload-body">
      <div class="rx-stage-wrap">
        <div class="rx-canvas-wrap">
          <canvas class="rx-stage" width="320" height="320"></canvas>
          <div class="rx-drop-hint" role="button" tabindex="0">Drop image here or click to choose</div>
        </div>
        <div class="rx-stage-ctl">
          <div class="rx-ctl-row">
            <label for="rx-zoom">Zoom</label>
            <input id="rx-zoom" type="range" min="0" max="1" step="0.001" value="0.5">
          </div>
          <div class="rx-ctl-row" style="display:flex;align-items:center;gap:8px">
            <label for="rx-rot">Rotate</label>
            <input id="rx-rot" type="range" min="-180" max="180" step="1" value="0" style="flex:1 1 auto">
          </div>
          <div class="rx-ctl-row" style="display:flex;align-items:center;gap:8px">
            <label>Drag</label>
            <span style="color:#aaa;font-size:12px">Click & drag the image</span>
            <button type="button" class="rx-btn rx-clear" style="margin-left:auto">Clear</button>
          </div>
        </div>
      </div>
      <div class="rx-side">
        <div class="rx-name-row">
          <label for="rx-name">Reaction name (4–16, letters/numbers/_)</label>
          <input id="rx-name" type="text" inputmode="latin" autocomplete="off" spellcheck="false" placeholder="e.g. party_parrot">
        </div>
        <div class="rx-msg" id="rx-msg"></div>
      </div>
    </div>
    <div class="rx-upload-foot">
      <button class="rx-btn rx-cancel" type="button">Cancel</button>
      <button class="rx-btn rx-create" type="button" disabled>Create</button>
    </div>`;
                    pop.appendChild(sheet);

                    const canvas = sheet.querySelector('canvas.rx-stage');
                    const ctx = canvas.getContext('2d');
                    const zoomCtl = sheet.querySelector('#rx-zoom');
                    const rotCtl = sheet.querySelector('#rx-rot');
                    const nameInp = sheet.querySelector('#rx-name');
                    const msgEl = sheet.querySelector('#rx-msg');
                    const btnCancel = sheet.querySelector('.rx-cancel');
                    const btnClose = sheet.querySelector('.rx-upload-close');
                    const btnCreate = sheet.querySelector('.rx-create');
                    const btnClear = sheet.querySelector('.rx-clear');
                    const wrap = sheet.querySelector('.rx-canvas-wrap');
                    const hint = sheet.querySelector('.rx-drop-hint');

                    // Hidden chooser lives INSIDE the sheet
                    const file = document.createElement('input');
                    file.type = 'file';
                    file.accept = 'image/*';
                    file.tabIndex = -1;
                    file.style.display = 'none';
                    sheet.appendChild(file);
                    file.addEventListener('click', e => e.stopPropagation(), true);

                    const state = { img: null, zoom: 1, rot: 0, panX: 0, panY: 0, dragging: false, dragStart: { x: 0, y: 0 }, panStart: { x: 0, y: 0 } };

                    wrap.addEventListener('click', (e) => {
                        if (state.img) return;                // only when empty
                        e.preventDefault(); e.stopPropagation();
                        file.click();
                    });

                    function setMsg(text, ok = false) { msgEl.textContent = text || ''; msgEl.className = 'rx-msg ' + (text ? (ok ? 'ok' : 'err') : ''); }
                    function clearMsg() { setMsg(''); }

                    function toggleHint() {
                        wrap.classList.toggle('has-image', !!state.img);
                    }

                    function drawBlank() {
                        ctx.setTransform(1, 0, 0, 1, 0, 0);
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.fillStyle = '#000';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        // guide
                        ctx.save();
                        ctx.strokeStyle = 'rgba(255,255,255,.18)';
                        ctx.lineWidth = 2;
                        ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
                        ctx.restore();
                    }

                    function draw() {
                        drawBlank();
                        if (!state.img) return;
                        const cw = canvas.width, ch = canvas.height;
                        ctx.save();
                        ctx.translate(cw / 2 + state.panX, ch / 2 + state.panY);
                        ctx.rotate(state.rot * Math.PI / 180);
                        const base = Math.min(cw / state.img.width, ch / state.img.height);
                        const s = base * state.zoom;
                        ctx.scale(s, s);
                        ctx.drawImage(state.img, -state.img.width / 2, -state.img.height / 2);
                        ctx.restore();
                    }

                    function resetFrame() {
                        state.img = null; state.zoom = 1; state.rot = 0; state.panX = 0; state.panY = 0;
                        zoomCtl.value = '0.5'; rotCtl.value = '0';
                        file.value = '';
                        toggleHint();
                        draw();
                        syncCreateEnabled();
                    }

                    function loadFromFile(f) {
                        if (!f) return;
                        const url = URL.createObjectURL(f);
                        const img = new Image();
                        img.onload = () => {
                            URL.revokeObjectURL(url);
                            state.img = img; state.zoom = 1; state.rot = 0; state.panX = 0; state.panY = 0;
                            zoomCtl.value = '0.5'; rotCtl.value = '0';
                            toggleHint(); clearMsg(); draw(); syncCreateEnabled();
                        };
                        img.onerror = () => setMsg('Could not load image');
                        img.src = url;
                    }

                    // Open chooser ONLY from the hint (when no image)
                    function openChooser(e) {
                        if (state.img) return;
                        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                        file.click();
                    }
                    hint.addEventListener('click', openChooser);
                    hint.addEventListener('keydown', (e) => {
                        if ((e.key === 'Enter' || e.key === ' ') && !state.img) openChooser(e);
                    });

                    file.addEventListener('change', (ev) => {
                        loadFromFile(ev.target.files?.[0]);
                        ev.target.value = '';
                    });

                    // Drag & drop still works over the whole wrap
                    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
                        wrap.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
                    });
                    wrap.addEventListener('drop', (e) => {
                        const f = e.dataTransfer?.files?.[0];
                        loadFromFile(f);
                    });

                    // Pan/zoom/rotate
                    wrap.addEventListener('mousedown', (e) => {
                        if (!state.img) return;            // with no image, hint handles chooser
                        e.preventDefault();
                        state.dragging = true;
                        state.dragStart = { x: e.clientX, y: e.clientY };
                        state.panStart = { x: state.panX, y: state.panY };
                    });
                    window.addEventListener('mousemove', (e) => {
                        if (!state.dragging) return;
                        state.panX = state.panStart.x + (e.clientX - state.dragStart.x);
                        state.panY = state.panStart.y + (e.clientY - state.dragStart.y);
                        draw();
                    }, { passive: true });
                    window.addEventListener('mouseup', () => { state.dragging = false; });

                    zoomCtl.addEventListener('input', () => { state.zoom = relFromNormalizedSlider(zoomCtl.value); draw(); });
                    rotCtl.addEventListener('input', () => { state.rot = parseFloat(rotCtl.value) || 0; draw(); });

                    // Name input
                    function sanitizeNameLive(v) { let s = String(v || '').replace(/[^A-Za-z0-9_]/g, ''); if (s.length > 16) s = s.slice(0, 16); return s; }
                    function nameValidNow() {
                        const n = nameInp.value.trim();
                        if (!RE_NAME.test(n)) return { ok: false, why: '4–16 chars: letters, numbers, underscore' };
                        if (looksBanned(n)) return { ok: false, why: 'That name is not allowed' };
                        return { ok: true };
                    }
                    function syncCreateEnabled() { btnCreate.disabled = !(state.img && nameValidNow().ok); }

                    nameInp.addEventListener('input', () => {
                        const caret = nameInp.selectionStart;
                        const cleaned = sanitizeNameLive(nameInp.value);
                        if (cleaned !== nameInp.value) {
                            nameInp.value = cleaned;
                            const pos = Math.max(0, (caret || 0) - 1);
                            nameInp.setSelectionRange(pos, pos);
                        }
                        const chk = nameValidNow();
                        if (!chk.ok) setMsg(chk.why); else clearMsg();
                        syncCreateEnabled();
                    });

                    // Clear button
                    btnClear.addEventListener('click', (e) => {
                        resetFrame();
                        btnClear.blur();
                    });

                    // Create
                    btnCreate.addEventListener('click', async () => {
                        clearMsg();
                        if (!state.img) { setMsg('Choose an image first.'); return; }
                        const chk = nameValidNow(); if (!chk.ok) { setMsg(chk.why); return; }

                        const out = document.createElement('canvas'); out.width = OUT_SIZE; out.height = OUT_SIZE;
                        const ox = out.getContext('2d');
                        ox.clearRect(0, 0, OUT_SIZE, OUT_SIZE);
                        ox.save();
                        ox.translate(OUT_SIZE / 2 + (state.panX * (OUT_SIZE / canvas.width)),
                            OUT_SIZE / 2 + (state.panY * (OUT_SIZE / canvas.height)));
                        ox.rotate(state.rot * Math.PI / 180);
                        const base = Math.min(OUT_SIZE / state.img.width, OUT_SIZE / state.img.height);
                        ox.scale(base * state.zoom, base * state.zoom);
                        ox.drawImage(state.img, -state.img.width / 2, -state.img.height / 2);
                        ox.restore();

                        const blob = await new Promise(res => out.toBlob(res, PNG_MIME));
                        if (!blob) { setMsg('Failed to encode PNG'); return; }
                        if (blob.size > MAX_BYTES) { setMsg('Image too large (>1MB). Zoom/crop more or pick a smaller image.'); return; }

                        try {
                            const fd = new FormData();
                            fd.append('image', blob, nameInp.value + '.png'); // server expects "image"
                            fd.append('name', nameInp.value);
                            await window.MessagesApp.api.api('/dm/reactions/custom/upload', { method: 'POST', body: fd });
                            setMsg('Created!', true);

                            try { await refreshLibrary(); } catch { }
                            try { await loadLibraryOnce(); } catch { }
                            refreshAll();

                            closeSheet();
                        } catch (err) {
                            setMsg((err?.detail || err?.message || 'Upload failed.'));
                        }
                    });

                    function closeSheet() {
                        sheet.remove();
                        file.remove();
                    }

                    // stop the click at capture so the document's capture listener can't see it
                    function stopAndClose(e) {
                        e.preventDefault();
                        e.stopPropagation();
                        closeSheet();
                    }

                    btnCancel.addEventListener('click', stopAndClose, true); // capture = true
                    btnClose.addEventListener('click', stopAndClose, true); // capture = true

                    // Start fresh
                    toggleHint();
                    draw();
                }

                // —— sections
                const sections = document.createElement('div'); sections.className = 'rx-sections';

                // RECENT
                const recentH1 = document.createElement('div'); recentH1.className = 'rx-h1'; recentH1.textContent = 'Recent';
                const recentGrid = document.createElement('div'); recentGrid.className = 'rx-grid'; recentGrid.id = 'rx-grid-recent';

                // CUSTOM
                const customH1 = document.createElement('div'); customH1.className = 'rx-h1'; customH1.textContent = 'Custom';
                const customGrid = document.createElement('div'); customGrid.className = 'rx-grid'; customGrid.id = 'rx-grid-custom';

                // Saved
                const savedH1 = document.createElement('div'); savedH1.className = 'rx-h1'; savedH1.textContent = 'Saved';
                const savedGrid = document.createElement('div'); savedGrid.className = 'rx-grid';

                // EMOJI (by categories)
                const emojiH1 = document.createElement('div'); emojiH1.className = 'rx-h1'; emojiH1.textContent = 'Emoji';
                const emojiCatsWrap = document.createElement('div');

                sections.append(recentH1, recentGrid, savedH1, savedGrid, customH1, customGrid, emojiH1, emojiCatsWrap);
                pop.append(head, sections);

                // portal + position + listeners
                portalOpen(pop, 'rx-pop--portal');
                inheritTheme(anchorEl?.closest?.('.msg') || anchorEl || document.querySelector('#msgs') || document.documentElement, pop);
                positionUnderAnchor(anchorEl || document.body, pop);
                bindReposition(pop, anchorEl || document.body);

                const row = anchorEl?.closest?.('.msg') || null;

                const cleanup = () => {
                    document.removeEventListener('click', onDocClick, true);
                    window.removeEventListener('keydown', onKey, true);
                    pop.dataset.open = '0';
                    pop._detachReposition?.();
                    portalClose(pop, 'rx-pop--portal');
                    pop.remove();
                    row && row.classList.remove('rx-open');
                    this.onClosed && this.onClosed();
                };
                const onDocClick = (ev) => { if (!pop.contains(ev.target)) cleanup(); };
                const onKey = (ev) => { if (ev.key === 'Escape') cleanup(); };
                setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
                window.addEventListener('keydown', onKey, true);
                this._cleanup = cleanup;

                // Filtering state
                const state = { q: '' };
                const qMatch = (txt) => {
                    const q = state.q; if (!q) return true;
                    return (txt || '').toLowerCase().includes(q.toLowerCase());
                };

                const renderRecent = () => {
                    recentGrid.innerHTML = '';
                    const list = (this.recent || []).slice(0, 24);
                    if (!list.length) { recentH1.style.display = 'none'; recentGrid.style.display = 'none'; return; }

                    const filtered = list.filter(k => {
                        if (k.startsWith('c:')) {
                            const meta = LIB.get(+k.slice(2));
                            return meta ? qMatch(meta.name || '') : false;
                        } else {
                            const uni = k.slice(2);
                            const e = this.EMOJI.find(x => x.u === uni);
                            return e ? (qMatch(e.n) || uni.includes(state.q)) : false;
                        }
                    });

                    if (!filtered.length) { recentH1.style.display = 'none'; recentGrid.style.display = 'none'; return; }
                    recentH1.style.display = ''; recentGrid.style.display = '';
                    filtered.forEach(k => {
                        if (k.startsWith('c:')) {
                            const id = +k.slice(2); const meta = LIB.get(id);
                            if (meta) recentGrid.appendChild(this._makeTile({ kind: 'custom', custom_emoji_id: id }, { saved: !!meta.saved, title: meta.name, imgUrl: meta.url }));
                        } else {
                            const uni = k.slice(2);
                            const e = this.EMOJI.find(x => x.u === uni);
                            if (e) recentGrid.appendChild(this._makeTile({ kind: 'emoji', unicode: e.u }, { title: e.n, text: e.u }));
                        }
                    });
                };

                const renderCustom = () => {
                    customGrid.innerHTML = '';
                    const items = Array.from(LIB.values() || []).filter(e => qMatch(e.name || ''));
                    if (!items.length) { customH1.style.display = 'none'; customGrid.style.display = 'none'; return; }
                    customH1.style.display = ''; customGrid.style.display = '';
                    items.forEach(e => {
                        customGrid.appendChild(this._makeTile(
                            { kind: 'custom', custom_emoji_id: e.id },
                            { saved: !!e.saved, title: e.name || 'Custom', imgUrl: e.url }
                        ));
                    });
                };

                const renderSaved = () => {
                    savedGrid.innerHTML = '';
                    const items = Array.from(LIB.values() || []).filter(e => e.saved && qMatch(e.name || ''));
                    if (!items.length) { savedH1.style.display = 'none'; savedGrid.style.display = 'none'; return; }
                    savedH1.style.display = ''; savedGrid.style.display = '';
                    items.forEach(e => {
                        savedGrid.appendChild(this._makeTile(
                            { kind: 'custom', custom_emoji_id: e.id },
                            { saved: true, title: e.name || 'Custom', imgUrl: e.url }
                        ));
                    });
                };

                const buildEmojiCategories = () => {
                    emojiCatsWrap.innerHTML = '';
                    const cats = [...new Set(this.EMOJI.map(e => e.cat))]; // already provided by constructor
                    cats.forEach(cat => {
                        const arr = this.EMOJI.filter(e => e.cat === cat && (qMatch(e.n) || e.u.includes(state.q)));
                        if (!arr.length) return;
                        const h2 = document.createElement('div'); h2.className = 'rx-h2'; h2.textContent = cat;
                        const grid = document.createElement('div'); grid.className = 'rx-grid';
                        arr.forEach(e => grid.appendChild(this._makeTile({ kind: 'emoji', unicode: e.u }, { title: e.n, text: e.u })));
                        emojiCatsWrap.append(h2, grid);
                    });
                    // hide the entire Emoji section if empty
                    emojiH1.style.display = emojiCatsWrap.childElementCount ? '' : 'none';
                };

                const refreshAll = () => {
                    renderRecent();
                    renderSaved();
                    renderCustom();
                    buildEmojiCategories();
                };

                search.addEventListener('input', () => { state.q = search.value.trim(); refreshAll(); });

                try { await loadLibraryOnce(); } catch { }
                refreshAll();
            }
        }

        // Minimal fallback emoji database (name + category). Provide your full list via window.MessagesApp.EMOJI_FULL.
        const DEFAULT_EMOJI = [
            { u: '👍', n: 'thumbs up', cat: 'Smileys' }, { u: '❤️', n: 'red heart', cat: 'Symbols' },
            { u: '😂', n: 'face with tears of joy', cat: 'Smileys' }, { u: '😮', n: 'face with open mouth', cat: 'Smileys' },
            { u: '😢', n: 'crying face', cat: 'Smileys' }, { u: '😡', n: 'pouting face', cat: 'Smileys' },
            { u: '🎉', n: 'party popper', cat: 'Activities' }, { u: '🙏', n: 'folded hands', cat: 'People' },
            { u: '🔥', n: 'fire', cat: 'Travel' }, { u: '👏', n: 'clapping hands', cat: 'People' },
            { u: '👌', n: 'ok hand', cat: 'People' }, { u: '🤝', n: 'handshake', cat: 'People' },
            // a few more popular ones
            { u: '😀', n: 'grinning face', cat: 'Smileys' }, { u: '😁', n: 'beaming face', cat: 'Smileys' },
            { u: '🤣', n: 'rolling on the floor laughing', cat: 'Smileys' }, { u: '😉', n: 'winking face', cat: 'Smileys' },
            { u: '😊', n: 'smiling face with smiling eyes', cat: 'Smileys' }, { u: '😎', n: 'smiling face with sunglasses', cat: 'Smileys' },
            { u: '🤔', n: 'thinking face', cat: 'Smileys' }, { u: '😴', n: 'sleeping face', cat: 'Smileys' },
            { u: '🤯', n: 'exploding head', cat: 'Smileys' }, { u: '🤗', n: 'hugging face', cat: 'Smileys' },
            { u: '💯', n: 'hundred points', cat: 'Symbols' }, { u: '✅', n: 'check mark button', cat: 'Symbols' },
            { u: '❌', n: 'cross mark', cat: 'Symbols' }, { u: '⚠️', n: 'warning', cat: 'Symbols' },
            { u: '✨', n: 'sparkles', cat: 'Symbols' }, { u: '🌟', n: 'glowing star', cat: 'Travel' },
            { u: '🍀', n: 'four leaf clover', cat: 'Food' }, { u: '🌈', n: 'rainbow', cat: 'Travel' },
            { u: '🐶', n: 'dog face', cat: 'Animals' }, { u: '🐱', n: 'cat face', cat: 'Animals' },
            { u: '👏', n: 'clapping hands', cat: 'People' }, { u: '🫡', n: 'saluting face', cat: 'Smileys' },
            { u: '🫶', n: 'heart hands', cat: 'People' }, { u: '🤌', n: 'pinched fingers', cat: 'People' },
            { u: '🧡', n: 'orange heart', cat: 'Symbols' }, { u: '💙', n: 'blue heart', cat: 'Symbols' },
            { u: '🙌', n: 'raising hands', cat: 'People' }, { u: '🤝', n: 'handshake', cat: 'People' },
            { u: '🎂', n: 'birthday cake', cat: 'Food' }, { u: '🍕', n: 'pizza', cat: 'Food' },
            { u: '☕', n: 'hot beverage', cat: 'Food' }, { u: '🏆', n: 'trophy', cat: 'Activities' },
            { u: '📎', n: 'paperclip', cat: 'Objects' }, { u: '📌', n: 'pushpin', cat: 'Objects' },
            { u: '📷', n: 'camera', cat: 'Objects' }, { u: '💡', n: 'light bulb', cat: 'Objects' },
            { u: '🚀', n: 'rocket', cat: 'Travel' }, { u: '✈️', n: 'airplane', cat: 'Travel' },
        ];

        const ReactionPickerUI = UI.ReactionPickerUI || RichReactionPickerUI;
        const renderReactionBar = UI.renderReactionBar || simpleRenderReactionBar;

        const LIB = new Map();         // custom_emoji_id -> url
        const MSG_BAR = new Map();     // msgId -> { barEl, meta }
        const SAVED_LS_KEY = 'rx.saved.v1';
        function _readSaved() { try { return new Set((JSON.parse(localStorage.getItem(SAVED_LS_KEY) || '[]') || []).map(Number)); } catch { return new Set(); } }
        function _writeSaved(set) { try { localStorage.setItem(SAVED_LS_KEY, JSON.stringify([...set])); } catch { } }
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
                    const ls = _readSaved();
                    items.forEach(e => {
                        if (e?.id && e?.url) {
                            const id = +e.id;
                            const savedServer = !!(e.saved ?? e.bookmarked ?? e.starred ?? e.is_saved);
                            const saved = savedServer || ls.has(id);
                            LIB.set(id, { id, url: e.url, name: e.name || '', saved });
                        }
                    });
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

        function urlForCustom(id) {
            const v = LIB.get(+id);
            return v ? (v.url || null) : null;
        }
        // Normalize many possible server shapes into { items: [...], reactable: bool }
        async function listForMessage(msgId) {
            const raw = await apiGet(`/dm/messages/${msgId}/reactions`).catch(() => ({}));

            // reactability flag (fallback true)
            const reactable = !!(raw.reactable ?? raw.reactions_enabled ?? raw.reactable_for_me ?? true);

            const items = [];
            const push = (it) => {
                // tolerate a bunch of field variants
                const key =
                    it.reaction_key || it.key ||
                    (it.unicode ? `u:${it.unicode}` :
                        (it.emoji ? `u:${it.emoji}` :
                            (it.custom_emoji_id != null ? `c:${it.custom_emoji_id}` :
                                (it.id != null ? `c:${it.id}` : null))));

                const kind = it.kind ||
                    (key && key.startsWith('c:') ? 'custom' : 'emoji');

                const unicode = it.unicode ?? it.emoji ?? (kind === 'emoji' && key?.startsWith('u:') ? key.slice(2) : null);
                const customId = it.custom_emoji_id ?? it.emoji_id ?? (kind === 'custom' && key?.startsWith('c:') ? +key.slice(2) : null);

                items.push({
                    reaction_key: key,           // canonical
                    key,                         // legacy field some code reads
                    kind,                        // 'emoji' | 'custom'
                    unicode: unicode || null,    // for emoji
                    custom_emoji_id: customId ?? null, // for custom
                    count: (it.count ?? it.n ?? it.total ?? (Array.isArray(it.users) ? it.users.length : 0)) | 0,
                    reacted_by_me: !!(it.reacted_by_me ?? it.me ?? it.mine ?? false),
                    // url is resolved at render time via urlForCustom()
                });
            };

            // Shape 1: { items: [...] }
            if (Array.isArray(raw.items)) raw.items.forEach(push);

            // Shape 2: { reactions: [...] }
            if (!items.length && Array.isArray(raw.reactions)) raw.reactions.forEach(push);

            // Shape 3: { counts: { "u:👍": {count, me} , "c:123": {count, me} } }
            if (!items.length && raw.counts && typeof raw.counts === 'object') {
                Object.entries(raw.counts).forEach(([k, v]) => {
                    const kind = k.startsWith('c:') ? 'custom' : 'emoji';
                    push({
                        reaction_key: k,
                        kind,
                        unicode: kind === 'emoji' ? k.slice(2) : null,
                        custom_emoji_id: kind === 'custom' ? +k.slice(2) : null,
                        count: v?.count || 0,
                        reacted_by_me: !!(v?.me || v?.mine || v?.reacted_by_me),
                    });
                });
            }

            // Shape 4: split arrays { unicode:[{unicode,count,me}], custom:[{id,count,me}] }
            if (!items.length && (Array.isArray(raw.unicode) || Array.isArray(raw.custom))) {
                (raw.unicode || []).forEach(u => push({
                    unicode: u.unicode ?? u.emoji ?? u.char,
                    count: u.count ?? u.n,
                    reacted_by_me: !!(u.me ?? u.mine ?? u.reacted_by_me),
                    kind: 'emoji'
                }));
                (raw.custom || []).forEach(c => push({
                    custom_emoji_id: c.custom_emoji_id ?? c.id,
                    count: c.count ?? c.n,
                    reacted_by_me: !!(c.me ?? c.mine ?? c.reacted_by_me),
                    kind: 'custom'
                }));
            }

            // De-dupe by key (just in case multiple shapes overlapped)
            const seen = new Map();
            items.forEach(it => {
                if (!it.key) return;
                const prev = seen.get(it.key);
                if (!prev || (it.count > prev.count)) seen.set(it.key, it);
            });

            return { items: [...seen.values()], reactable };
        }

        async function toggleByKey(msgId, reaction_key) {
            // send the exact shape the server expects
            return await apiPost(`/dm/messages/${msgId}/reactions/toggle`, { reaction_key });
        }

        async function toggleAndRefresh(msgId, reaction_key) {
            await toggleByKey(msgId, reaction_key);
            await renderBarFor(msgId);
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

        // Toggle bookmark for a custom emoji (used by chips & picker)
        async function toggleCustomBookmark(id, want) {
            if (!id) return;
            const overlayAPI = window.UIOverlays?.CustomEmoji;
            try {
                if (overlayAPI?.toggleBookmark) {
                    await overlayAPI.toggleBookmark(id, want);
                } else {
                    const tries = [
                        () => want
                            ? window.MessagesApp.api.api(`/dm/reactions/custom/${id}/bookmark`, { method: 'POST' })
                            : window.MessagesApp.api.api(`/dm/reactions/custom/${id}/bookmark`, { method: 'DELETE' }),
                        () => apiPost('/dm/reactions/custom/bookmark', { emoji_id: +id, save: !!want }),
                        () => apiPost('/dm/reactions/custom/bookmarks/toggle', { id: +id, save: !!want }),
                        () => apiPost('/dm/reactions/custom/library', { id: +id, bookmarked: !!want }),
                    ];
                    for (const t of tries) { try { await t(); break; } catch { } }
                }
            } finally {
                const meta = LIB.get(+id);
                if (meta) meta.saved = !!want;
            }
        }

        // After the bar renders, decorate chips with a hover-only bookmark nub
        function ensureBookmarkOverlays(barEl, items) {
            const chips = Array.from(barEl.querySelectorAll('.rx-chip, [data-rx-key]'));
            if (!chips.length) return;

            chips.forEach((chip, idx) => {
                let key = chip.getAttribute('data-rx-key') || chip.dataset.rxKey || chip.dataset.key || null;
                if (!key && items && items[idx] && items[idx].reaction_key) {
                    key = items[idx].reaction_key;          // fallback: align by index
                    chip.setAttribute('data-rx-key', key);
                }
                if (!key || !key.startsWith('c:')) return;  // custom-only

                const id = +key.slice(2);
                let bm = chip.querySelector(':scope > .rx-bm');
                if (!bm) {
                    bm = document.createElement('button');
                    bm.type = 'button';
                    bm.className = 'rx-bm';
                    chip.appendChild(bm);

                    // capture-phase so it doesn't bubble to the chip toggle
                    bm.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopImmediatePropagation();
                        e.stopPropagation();
                        const want = !Boolean(LIB.get(id)?.saved);
                        toggleCustomBookmark(id, want).then(() => {
                            const savedNow = !!LIB.get(id)?.saved;
                            bm.classList.toggle('saved', savedNow);
                            bm.textContent = savedNow ? '★' : '☆';
                            bm.title = savedNow ? 'Remove from favorites' : 'Save to favorites';
                        }).catch(() => { });
                    }, true);
                }

                const saved = !!LIB.get(id)?.saved;
                bm.classList.toggle('saved', saved);
                bm.textContent = saved ? '★' : '☆';
                bm.title = saved ? 'Remove from favorites' : 'Save to favorites';
            });
        }

        async function renderBarFor(msgId) {
            const info = MSG_BAR.get(msgId);
            if (!info) return;
            const { barEl } = info;

            let j = {};
            try { j = await listForMessage(msgId); } catch { j = {}; }
            const items = j.items || [];

            const reactable = (j.reactable !== undefined) ? !!j.reactable : (function rowReactable(msgId) {
                const row = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
                if (!row) return true;
                const ds = row.dataset || {};
                if (ds.reactable != null) return (ds.reactable === '1' || ds.reactable === 'true');
                const meta = state.convMeta.get(state.convId) || {};
                let on = !!(meta.reactions_enabled ?? meta.reactable ?? true);
                if (on && meta.reactions_effective_from_ts && ds.ts) {
                    on = (+ds.ts * 1000) >= meta.reactions_effective_from_ts;
                }
                return on;
            })(msgId);

            barEl.innerHTML = '';
            renderReactionBar(barEl, items, {
                disabled: !reactable,
                customUrlFor: urlForCustom,
                onOpenPicker: () => openPicker(barEl, { id: msgId, reactable }),
                onToggle: async (reaction_key) => {
                    if (!reaction_key) return;
                    await toggleByKey(msgId, reaction_key);
                    await renderBarFor(msgId);
                }
            });

            // Normalize HTML so unicode/custom chips match structure
            normalizeReactionGlyphs(barEl);

            // Add hover-only bookmark to custom chips
            ensureBookmarkOverlays(barEl, items);
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
            picker.open(message.id, anchorEl);

            // Ensure rx-open clears on Escape too
            const row = anchorEl?.closest?.('.msg') || null;
            const escToClear = (ev) => {
                if (ev.key === 'Escape') {
                    row && row.classList.remove('rx-open');
                    document.removeEventListener('keydown', escToClear, true);
                }
            };
            document.addEventListener('keydown', escToClear, true);

            // existing outside-click watcher remains as-is
            setTimeout(() => {
                const closeWatcher = (ev) => {
                    if (!document.getElementById('rx-fallback-pop')) {
                        row && row.classList.remove('rx-open');
                        document.removeEventListener('click', closeWatcher, true);
                        document.removeEventListener('keydown', escToClear, true);
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
        async function refreshLibrary() { _libCache = null; await loadLibraryOnce(); }

        // expose
        window.MessagesApp.reactions = { init, attachBar, openPicker, bindStream, toggle: toggleAndRefresh, refreshLibrary };
    })();

    // expose for wiring + safety
    Object.assign(window.MessagesApp, {
        chat: {
            fetchConvMeta, setConvMeta, updateTopBar, renderConvs, loadConversations, openConversation,
            startDmWith, fetchFriends, maybeAutoRenameGroup, sendMessage,
            createGroup: createGroupFromIds,
            setGroupNameAndColor,            // ← NEW export
        },
        revoke: { revokeAudioURLsIn, revokeObjectURLsIn }
    });

    // Universal click-to-toggle for reaction chips.
    // Capture phase so it works even if other handlers stopPropagation.
    document.addEventListener('click', async (ev) => {
        // NEW: ignore clicks on the bookmark nub
        if (ev.target && ev.target.closest('.rx-bm')) return;

        const chip = ev.target && (ev.target.closest('[data-rx-key]') || ev.target.closest('.rx-chip'));
        if (!chip) return;
        const row = chip.closest('.msg');
        const bar = chip.closest('.reactions');
        if (!row || !bar) return;
        const msgId = +(row.dataset.msgId || 0);
        const key = chip.getAttribute('data-rx-key') || chip.dataset.rxKey || chip.dataset.key || null;
        if (!msgId || !key) return;

        ev.preventDefault();
        ev.stopPropagation();

        try {
            chip.disabled = true;
            await (window.MessagesApp.reactions && window.MessagesApp.reactions.toggle?.(msgId, key));
        } finally {
            chip.disabled = false;
        }
    }, true);

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
            if (exists) {
                await openConversation(exists.id);
            } else {
                // Not in the fetched list (likely empty). Add placeholder and open it.
                ensureConvInList(last.convId | 0);
                await openConversation(last.convId | 0);
            }
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
                    rename: () => GROUPS?.renameToMembers?.(window.MessagesApp.state.convId),
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