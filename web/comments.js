/* DailyPlea — Comments UI
   Drop-in replacement. No external deps.
   Exposes: window.Comments.mount({...})
*/
(() => {
    const DEFAULTS = {
        rootSelector: '#comments',
        pleaId: null,              // required
        apiBase: 'http://localhost:3000',
        sort: 'hottest',
        pageSize: 10,
    };

    // ---------- tiny DOM helpers ----------
    const el = (tag, attrs = {}, ...kids) => {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === 'class') n.className = v || '';
            else if (k === 'dataset') Object.assign(n.dataset, v || {});
            else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
            else if (v !== null && v !== undefined) n.setAttribute(k, String(v));
        }
        for (const kid of kids.flat()) {
            if (kid == null || kid === false) continue;
            n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
        }
        return n;
    };

    const fmtTime = (iso) => {
        try {
            const d = new Date(iso);
            if (!isFinite(d)) return '';
            return d.toLocaleString();
        } catch { return ''; }
    };

    // ---------- response normalization ----------
    const getId = (c) => c?.id ?? c?.comment_id ?? c?._id ?? null;
    const getAuthor = (c) => c?.author?.display_name ?? c?.author?.name ?? c?.user?.name ?? c?.username ?? 'Anonymous';
    const getText = (c) => c?.text ?? c?.body ?? c?.content ?? '';
    const getScore = (c) => c?.score ?? c?.votes ?? 0;
    const getCreatedIso = (c) => c?.created_at ?? c?.createdAt ?? c?.timestamp ?? null;
    const getReplyCount = (c) =>
        c?.reply_count ?? c?.replies_count ?? c?.children_count ??
        (Array.isArray(c?.replies) ? c.replies.length : 0) ?? 0;

    // Items array from various shapes
    const pickItems = (data) => data?.items ?? data?.comments ?? data?.data ?? [];

    const { db, hasColumn } = require('../db'); // hasColumn exists in your db.js

    // ---------- AVATARS ----------
    // auto-inject minimal CSS so avatar lays out next to content
    function ensureAvatarStyles() {
        if (document.getElementById('dp-comments-avatar-css')) return;
        const css = `
        .comments .comment { display: grid; grid-template-columns: 32px 1fr; gap: var(--c-gap,12px); }
        .comments .comment__avatar {
            width: 32px; height: 32px; border-radius: 50%;
            object-fit: cover; background: #e5e7eb; display:block;
        }
        .comments .comment__main { min-width: 0; } /* avoid overflow */
        `;
        const style = document.createElement('style');
        style.id = 'dp-comments-avatar-css';
        style.textContent = css;
        document.head.appendChild(style);
    }

    const AVATAR_FALLBACK =
        'data:image/svg+xml;utf8,' +
        encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
    <rect width="100%" height="100%" fill="#e5e7eb"/>
    <circle cx="32" cy="24" r="14" fill="#cbd5e1"/>
    <rect x="10" y="40" width="44" height="16" rx="8" fill="#cbd5e1"/>
  </svg>`);

    function getAuthorUsername(c) {
        return c?.author?.username ?? c?.user?.username ?? c?.username ?? null;
    }
    function getAuthorFirstUsername(c) {
        return c?.author?.first_username ?? c?.user?.first_username ?? c?.first_username ?? null;
    }
    function getAuthorPhotoInline(c) {
        return c?.author?.profile_photo ?? c?.user?.profile_photo ?? c?.profile_photo ?? c?.author?.photo ?? null;
    }

    // cache resolved avatars (username → url or null). Promises allowed to dedupe concurrent lookups.
    const avatarCache = new Map();

    async function resolveAvatarByUsername(apiBase, username) {
        if (!username) return null;
        const key = username.toLowerCase();
        if (avatarCache.has(key)) return await avatarCache.get(key);

        const p = (async () => {
            try {
                // Try by current username
                let r = await fetch(`${apiBase}/api/users/by_username/${encodeURIComponent(username)}`, { credentials: 'include' });
                if (r.ok) {
                    const j = await r.json().catch(() => ({}));
                    return j?.user?.profile_photo ?? null;
                }
                // Fallback resolver
                r = await fetch(`${apiBase}/api/users/resolve?username=${encodeURIComponent(username)}`, { credentials: 'include' });
                if (r.ok) {
                    const j = await r.json().catch(() => ({}));
                    return j?.user?.profile_photo ?? null;
                }
            } catch { /* ignore */ }
            return null;
        })();

        avatarCache.set(key, p);
        const url = await p;
        avatarCache.set(key, url);
        return url;
    }

    // ---------- (unused here but kept) admin helpers ----------
    function buildAdminExpr() {
        const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
        if (cols.includes('is_admin')) return 'u.is_admin';
        if (cols.includes('admin')) return 'u.admin';
        if (cols.includes('role')) return "CASE WHEN u.role IN ('admin','owner','moderator') THEN 1 ELSE 0 END";
        return '0';
    }

    function canUserEditOrDelete(commentId, actingUserId) {
        const adminExpr = buildAdminExpr();
        const stmt = db.prepare(`
    SELECT
      (c.user_id = @uid) AS is_owner,
      ${adminExpr}       AS is_admin
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.id = @cid
  `);
        const row = stmt.get({ uid: actingUserId, cid: commentId });
        return !!row && (row.is_owner === 1 || row.is_admin === 1);
    }

    // ---------- API ----------
    async function fetchComments(apiBase, pleaId, sort, page, pageSize) {
        const url = new URL(`${apiBase}/api/pleas/${encodeURIComponent(pleaId)}/comments`);
        url.searchParams.set('sort', sort);
        url.searchParams.set('page', String(page));
        url.searchParams.set('page_size', String(pageSize));
        const r = await fetch(url.toString(), { credentials: 'include' });
        if (!r.ok) throw new Error(`comments fetch ${r.status}`);
        return r.json();
    }

    // Try /api/comments/:id/replies, then fallback to /api/pleas/:pleaId/comments?parent_id=...
    async function fetchReplies(apiBase, pleaId, parentId, sort, page, pageSize) {
        const primary = new URL(`${apiBase}/api/comments/${encodeURIComponent(parentId)}/replies`);
        primary.searchParams.set('sort', sort);
        primary.searchParams.set('page', String(page));
        primary.searchParams.set('page_size', String(pageSize));
        let r = await fetch(primary.toString(), { credentials: 'include' });
        if (r.ok) return r.json();

        // Fallback
        const fallback = new URL(`${apiBase}/api/pleas/${encodeURIComponent(pleaId)}/comments`);
        fallback.searchParams.set('sort', sort);
        fallback.searchParams.set('page', String(page));
        fallback.searchParams.set('page_size', String(pageSize));
        fallback.searchParams.set('parent_id', String(parentId));
        r = await fetch(fallback.toString(), { credentials: 'include' });
        if (!r.ok) throw new Error(`replies fetch ${r.status}`);
        return r.json();
    }

    // ---------- Rendering ----------
    function renderCommentNode(c, state) {
        const cid = getId(c);
        const replyCount = getReplyCount(c);

        // avatar element (inline photo or fallback; then lazy-resolve by username)
        const img = el('img', {
            class: 'comment__avatar',
            alt: '',
            src: getAuthorPhotoInline(c) || AVATAR_FALLBACK,
            referrerpolicy: 'no-referrer',
            style: 'width:32px;height:32px;border-radius:50%;object-fit:cover;display:block;background:#e5e7eb;'
        });

        if (!getAuthorPhotoInline(c)) {
            const uname = getAuthorUsername(c) || getAuthorFirstUsername(c);
            if (uname) {
                resolveAvatarByUsername(state.apiBase, uname).then((url) => {
                    if (url) img.src = url;
                });
            }
        }

        const meta = el('div', { class: 'comment__meta' },
            el('span', { class: 'comment__author' }, getAuthor(c)),
            el('span', { class: 'comment__dot' }, ' · '),
            el('time', { class: 'comment__time' }, fmtTime(getCreatedIso(c))),
            el('span', { class: 'comment__dot' }, ' · '),
            el('span', { class: 'comment__score' }, `${getScore(c)}↑`)
        );

        const body = el('div', { class: 'comment__body' }, getText(c));

        // replies container (collapsed by default)
        const repliesWrap = el('div', { class: 'comment__replies', dataset: { loaded: 'false' } });

        // actions row (toggle replies if any)
        const actions = el('div', { class: 'comment__actions' });
        if (replyCount > 0 && cid != null) {
            const toggle = el('button', {
                class: 'btn btn-link replies-toggle',
                type: 'button',
                onclick: async (e) => {
                    e.preventDefault();
                    const expanded = repliesWrap.getAttribute('data-expanded') === 'true';
                    if (expanded) {
                        repliesWrap.style.display = 'none';
                        repliesWrap.setAttribute('data-expanded', 'false');
                        toggle.textContent = `View replies (${replyCount})`;
                        return;
                    }
                    repliesWrap.style.display = '';
                    repliesWrap.setAttribute('data-expanded', 'true');
                    toggle.textContent = 'Hide replies';

                    if (repliesWrap.getAttribute('data-loaded') !== 'true') {
                        toggle.disabled = true;
                        try {
                            const data = await fetchReplies(state.apiBase, state.pleaId, cid, state.sort, 1, Math.max(10, replyCount));
                            const items = pickItems(data);
                            const list = el('div', { class: 'comment__replies-list' });
                            for (const rc of items) list.appendChild(renderCommentNode(rc, state));
                            repliesWrap.appendChild(list);
                            repliesWrap.setAttribute('data-loaded', 'true');
                        } catch {
                            repliesWrap.appendChild(el('div', { class: 'comment__error' }, 'Failed to load replies.'));
                        } finally {
                            toggle.disabled = false;
                        }
                    }
                }
            }, `View replies (${replyCount})`);
            actions.appendChild(toggle);
        }

        // layout: avatar on the left, content on the right
        const main = el('div', { class: 'comment__main' }, meta, body, actions, repliesWrap);
        const node = el('div', { class: 'comment', id: cid ? `c_${cid}` : null }, img, main);
        return node;
    }

    function renderBatch(items, listEl, state) {
        const frag = document.createDocumentFragment();
        for (const c of items) frag.appendChild(renderCommentNode(c, state));
        listEl.appendChild(frag);
    }

    function centerMoreWrap(btn) {
        const wrap = el('div', { class: 'comments__more' }, btn);
        return wrap;
    }

    // ---------- Mount ----------
    async function mount(opts = {}) {
        const state = Object.assign({}, DEFAULTS, opts || {});
        if (!state.pleaId) throw new Error('Comments.mount: pleaId is required');

        const root = document.querySelector(state.rootSelector);
        if (!root) throw new Error(`Comments.mount: root "${state.rootSelector}" not found`);

        // ensure avatar CSS is present
        ensureAvatarStyles();

        root.classList.add('comments');
        root.innerHTML = ''; // clean mount point

        const header = el('div', { class: 'comments__header' },
            el('h3', { class: 'comments__title' }, 'Comments')
        );
        const list = el('div', { class: 'comments__list' });
        const moreBtn = el('button', {
            class: 'btn comments__more-btn',
            type: 'button',
            onclick: async () => {
                moreBtn.disabled = true;
                moreBtn.textContent = 'Loading...';
                try {
                    state.page += 1;
                    const data = await fetchComments(state.apiBase, state.pleaId, state.sort, state.page, state.pageSize);
                    const items = pickItems(data);
                    renderBatch(items, list, state);
                    // hide if less than pageSize returned
                    if (!Array.isArray(items) || items.length < state.pageSize) {
                        moreWrap.remove();
                    } else {
                        moreBtn.disabled = false;
                        moreBtn.textContent = 'View more comments';
                    }
                } catch (err) {
                    moreBtn.textContent = 'Failed. Try again';
                    moreBtn.disabled = false;
                }
            }
        }, 'View more comments');

        const moreWrap = centerMoreWrap(moreBtn);

        root.append(header, list, moreWrap);

        // first page
        state.page = 1;
        try {
            const data = await fetchComments(state.apiBase, state.pleaId, state.sort, state.page, state.pageSize);
            const items = pickItems(data);
            renderBatch(items, list, state);

            // Centering logic: keep button only if more likely pages
            if (!Array.isArray(items) || items.length < state.pageSize) {
                moreWrap.remove();
            }
        } catch (err) {
            list.appendChild(el('div', { class: 'comments__error' }, 'Failed to load comments.'));
            moreWrap.remove();
        }
    }

    // expose
    window.Comments = { mount };
})();
