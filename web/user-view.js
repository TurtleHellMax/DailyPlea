console.log("[user-view.js] loaded");

(() => {
    "use strict";

    const API_BASE = "http://localhost:3000/api";
    const $ = (id) => document.getElementById(id);

    const state = {
        slug: "",
        profile: null,
        isOwner: false,
        pleaTitleMap: new Map(),
        // activity paging
        offset: 0,
        limit: 10,
        total: 0,
        loading: false,
        // group containers we’ve already created, by plea_num
        domGroups: new Map()
    };

    /* ---------- CSRF + API ---------- */
    async function fetchCsrf() {
        const r = await fetch(API_BASE.replace("/api", "") + "/api/csrf", { credentials: "include" });
        const j = await r.json().catch(() => ({}));
        const tok = j?.token ?? j?.csrfToken ?? j?.csrf ?? null;
        if (!r.ok || !tok) throw new Error("csrf");
        return tok;
    }

    async function api(path, opts = {}) {
        const method = (opts.method || "GET").toUpperCase();
        const headers = Object.assign({}, opts.headers || {});
        if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";
        if (method !== "GET" && !headers["x-csrf-token"]) {
            const t = await fetchCsrf();
            headers["x-csrf-token"] = t;
        }
        const r = await fetch(API_BASE + path, { method, headers, credentials: "include", body: opts.body });
        const txt = await r.text();
        let data;
        try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
        if (!r.ok) {
            const err = new Error(data?.error || r.statusText);
            err.status = r.status; err.data = data; err.detail = data?.detail || txt;
            throw err;
        }
        return data;
    }

    /* ---------- utils ---------- */
    function extractSlugFromPath(path) {
        const p = path.replace(/\/+$/, "");
        const m = p.match(/^\/user\/([^\/?#]+)(?:[\/?#]|$)/i);
        return m ? decodeURIComponent(m[1]) : "";
    }
    const firstNonEmpty = (...vals) => {
        for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
        return "";
    };
    const escapeHtml = (s) => String(s || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    /* ---------- render profile header ---------- */
    function renderHeader() {
        const u = state.profile;
        if (!u) return;
        $("uname").textContent = u.username || u.first_username || state.slug;
        $("pfp").src = u.profile_photo || "";
        const bio = firstNonEmpty(u.bio_html, u.bio);
        $("bio").innerHTML = bio || "";
        const btn = $("btn-edit");
        if (btn) {
            if (u.is_me) {
                btn.style.display = "";
                btn.href = `/user/${encodeURIComponent(state.slug)}/edit`;
            } else {
                btn.style.display = "none";
            }
        }
    }

    /* ---------- group DOM helper ---------- */
    function ensureGroup(pleaNum) {
        if (state.domGroups.has(pleaNum)) return state.domGroups.get(pleaNum);

        const wrap = document.createElement("div");
        wrap.className = "group";
        wrap.dataset.plea = String(pleaNum);

        const h = document.createElement("h3");
        const a = document.createElement("a");
        a.href = `/pleas/${encodeURIComponent(pleaNum)}`;
        a.textContent = state.pleaTitleMap.get(pleaNum) || `Plea #${pleaNum}`;
        h.appendChild(a);

        const list = document.createElement("div");
        list.className = "list";

        wrap.appendChild(h);
        wrap.appendChild(list);
        $("groups").appendChild(wrap);

        state.domGroups.set(pleaNum, list);
        return list;
    }

    /* ---------- inline editor helper (revised) ---------- */
    // Mounts the editor *after* `mountAfter` (we'll pass the repliesWrap to be beneath everything)
    // Also ensures only one editor lives under the same .comment container.
    function openInlineEditor(opts, mountAfter) {
        const commentRoot = mountAfter?.closest('.comment') || document.body;
        const existing = commentRoot.querySelector('.reply-editor');
        if (existing) existing.remove();

        const ed = document.createElement('div');
        ed.className = 'comment reply-editor';
        ed.innerHTML = `
    <textarea class="field-box" style="min-height:80px">${(opts.initial || "")
                .replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]))}</textarea>
    <div class="actions" style="margin-top:8px">
      <button class="btn primary js-ok">Save</button>
      <button class="btn js-cancel" type="button">Cancel</button>
    </div>
  `;

        const ta = ed.querySelector('textarea');
        ed.querySelector('.js-ok').addEventListener('click', async () => {
            const val = ta.value.trim();
            if (!val) return;
            await opts.onSubmit(val, ed);
        });
        ed.querySelector('.js-cancel').addEventListener('click', () => ed.remove());

        if (mountAfter) {
            mountAfter.insertAdjacentElement('afterend', ed);
        } else {
            (document.querySelector('#comments') || document.body).appendChild(ed);
        }
    }

    /* ---------- helpers ---------- */
    const isReplyItem = (it) =>
        !!(it.parent || it.parent_id != null || it.in_reply_to != null || it.reply_to != null || it.is_reply === true);

    /* ---------- Voting (modeled after main.js) ---------- */
    async function apiGetMyVote(pleaNum, id) {
        const tries = [
            `/comments/${encodeURIComponent(id)}/my_vote`,
            `/comments/${encodeURIComponent(id)}/vote`,
            `/pleas/${encodeURIComponent(pleaNum)}/comments/${encodeURIComponent(id)}/vote`
        ];
        for (const url of tries) {
            try {
                const j = await api(url); // GET
                if (j && (j.vote === "up" || j.direction === "up" || j.value === 1 || j.delta === 1 || j.liked === true)) return 1;
                if (j && (j.vote === "down" || j.direction === "down" || j.value === -1 || j.delta === -1 || j.disliked === true)) return -1;
                if (typeof j?.my_vote === "number") return j.my_vote > 0 ? 1 : j.my_vote < 0 ? -1 : 0;
            } catch { /* try next */ }
        }
        return 0;
    }

    async function apiSetMyVote(pleaNum, id, newVote) {
        try {
            const r = await api(`/comments/${encodeURIComponent(id)}/vote`, {
                method: "POST",
                body: JSON.stringify({ value: newVote })
            });
            if (r && (typeof r.likes !== "undefined" || typeof r.dislikes !== "undefined")) {
                return { ok: true, likes: +r.likes || 0, dislikes: +r.dislikes || 0, my: (typeof r.my_vote === "number") ? r.my_vote : newVote };
            }
            return { ok: true, likes: null, dislikes: null, my: newVote };
        } catch {
            if (newVote === 0) {
                try {
                    await api(`/comments/${encodeURIComponent(id)}/vote`, { method: "DELETE" });
                    return { ok: true, likes: null, dislikes: null, my: 0 };
                } catch { /* fall through */ }
            }
            const mv = await apiGetMyVote(pleaNum, id);
            return { ok: true, likes: null, dislikes: null, my: mv };
        }
    }

    function makeVoteController({ pleaNum, id, likeBtn, dislikeBtn,
        initialUps = 0, initialDowns = 0, initialMy = 0, onCountsChanged }) {

        const st = { ups: +initialUps || 0, downs: +initialDowns || 0, my: (typeof initialMy === "number" ? initialMy : 0), resolved: (initialMy === 1 || initialMy === -1) };

        function render() {
            if (likeBtn) {
                likeBtn.textContent = `▲ ${st.ups}`;
                likeBtn.classList.toggle("is-active", st.my === 1);
                likeBtn.classList.remove("is-down");
            }
            if (dislikeBtn) {
                dislikeBtn.textContent = `▼ ${st.downs}`;
                dislikeBtn.classList.toggle("is-down", st.my === -1);
                dislikeBtn.classList.remove("is-active");
            }
        }

        async function ensureKnownMy() {
            if (st.resolved) return;
            const v = await apiGetMyVote(pleaNum, id).catch(() => 0);
            if (v === 1 || v === -1 || v === 0) { st.my = v; st.resolved = true; render(); }
        }

        async function setMy(nextMy) {
            likeBtn && (likeBtn.disabled = true);
            dislikeBtn && (dislikeBtn.disabled = true);

            await ensureKnownMy();
            const prev = st.my;
            if (nextMy === prev) nextMy = 0; // toggle off

            // optimistic highlight only
            st.my = nextMy; render();

            try {
                const r = await apiSetMyVote(pleaNum, id, nextMy);

                if (r.likes != null && r.dislikes != null) {
                    st.ups = r.likes; st.downs = r.dislikes;
                } else {
                    const after = (typeof r.my === "number") ? r.my : nextMy;
                    const dUp = (after === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
                    const dDown = (after === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
                    st.ups = Math.max(0, st.ups + dUp);
                    st.downs = Math.max(0, st.downs + dDown);
                }

                st.my = (typeof r.my === "number") ? r.my : nextMy;
                st.resolved = true;
                render();
                onCountsChanged && onCountsChanged(st);

                // verify after write
                const verify = await apiGetMyVote(pleaNum, id).catch(() => st.my);
                if (verify !== st.my) { st.my = verify; render(); }
            } finally {
                likeBtn && (likeBtn.disabled = false);
                dislikeBtn && (dislikeBtn.disabled = false);
            }
        }

        likeBtn && likeBtn.addEventListener("click", () => setMy(1));
        dislikeBtn && dislikeBtn.addEventListener("click", () => setMy(-1));
        render();
        ensureKnownMy();

        return { state: st, render, setMy };
    }

    function nRepliesCount(it) {
        const a = it.reply_count ?? it.replies_count ?? it.children_count;
        if (Number.isFinite(a)) return +a;
        if (Array.isArray(it.replies)) return it.replies.length;
        return 0;
    }

    async function apiReplies(parentId) {
        const j = await api(`/comments/${encodeURIComponent(parentId)}/replies`);
        return Array.isArray(j?.items) ? j.items : (Array.isArray(j) ? j : []);
    }

    /* ---------- render one item (comment or reply-with-parent) ---------- */
    function renderItem(container, item) {
        const node = document.createElement("div");
        node.className = "comment";
        node.dataset.commentId = item.id;

        // If this item is itself a reply, show parent context (read-only)
        const thisIsReply = isReplyItem(item);
        if (thisIsReply && item.parent) {
            const parent = document.createElement("div");
            parent.className = "parent";
            const who = item.parent.author_username || item.parent.author_first_username || "User";
            parent.innerHTML =
                `<div class="muted">In reply to <b>${escapeHtml(who)}</b>:</div>` +
                `<div>${escapeHtml(item.parent.body || "")}</div>`;
            node.appendChild(parent);
        }

        // body
        const body = document.createElement("div");
        body.className = "body";
        body.innerHTML = escapeHtml(item.body || "");
        node.appendChild(body);

        // meta
        const meta = document.createElement("div");
        meta.className = "muted";
        meta.textContent = new Date(item.created_at).toLocaleString();
        node.appendChild(meta);

        // actions row (like/dislike + (maybe) reply + edit/delete)
        const actions = document.createElement("div");
        actions.className = "actions";

        // like / dislike
        const likeBtn = document.createElement("button");
        likeBtn.className = "btn js-like";
        likeBtn.textContent = `▲ ${item.likes | 0}`;

        const dislikeBtn = document.createElement("button");
        dislikeBtn.className = "btn js-dislike";
        dislikeBtn.textContent = `▼ ${item.dislikes | 0}`;

        actions.appendChild(likeBtn);
        actions.appendChild(dislikeBtn);

        const vc = makeVoteController({
            pleaNum: item.plea_num,
            id: item.id,
            likeBtn,
            dislikeBtn,
            initialUps: item.likes | 0,
            initialDowns: item.dislikes | 0,
            initialMy: 0,
            onCountsChanged: (s) => {
                likeBtn.textContent = `▲ ${s.ups}`;
                dislikeBtn.textContent = `▼ ${s.downs}`;
            }
        });
        apiGetMyVote(item.plea_num, item.id).then(v => {
            if (v !== vc.state.my) { vc.state.my = v; vc.render(); }
        }).catch(() => { });

        // We'll mount the reply editor at the very bottom (beneath replies)
        // so create a stable "bottom anchor" here:
        const bottomAnchor = document.createElement('div');
        bottomAnchor.className = 'reply-anchor';

        /* ---------- Replies UI (top-level comments only) ---------- */
        let repliesWrap = null, repliesList = null, toggleRepliesBtn = null;
        const isTopLevel = !thisIsReply;

        if (isTopLevel) {
            // Always create the replies container so we can mount the editor beneath it
            repliesWrap = document.createElement("div");
            repliesWrap.className = "replies";
            repliesWrap.style.display = "none";

            repliesList = document.createElement("div");
            repliesList.className = "replies-list";
            repliesWrap.appendChild(repliesList);

            toggleRepliesBtn = document.createElement("button");
            toggleRepliesBtn.className = "btn js-toggle-replies";
            toggleRepliesBtn.style.display = "none"; // hidden until we confirm there are replies
            toggleRepliesBtn.textContent = "View replies (0)";

            async function refreshReplies(openAfter = false) {
                const reps = await apiReplies(item.id).catch(() => []);
                repliesList.innerHTML = "";
                if (!reps.length) {
                    const empty = document.createElement("div");
                    empty.className = "muted";
                    empty.textContent = "(No replies)";
                    repliesList.appendChild(empty);
                    toggleRepliesBtn.textContent = "View replies (0)";
                    toggleRepliesBtn.style.display = "none"; // hide if none
                } else {
                    for (const r of reps) repliesList.appendChild(renderOneReply(r, item.plea_num));
                    toggleRepliesBtn.textContent = "Hide replies";
                    toggleRepliesBtn.style.display = ""; // show if any
                }
                if (openAfter) {
                    repliesWrap.style.display = "";
                    toggleRepliesBtn.textContent = "Hide replies";
                } else {
                    const isOpen = repliesWrap.style.display !== "none";
                    if (!isOpen) toggleRepliesBtn.textContent = `View replies (${reps.length})`;
                }
            }

            // Initial presence check (covers servers that don’t send reply_count)
            // If your API is heavy, change to a HEAD/count endpoint.
            (async () => {
                const known = nRepliesCount(item);
                if (known > 0) {
                    toggleRepliesBtn.style.display = "";
                    toggleRepliesBtn.textContent = `View replies (${known})`;
                } else {
                    const reps = await apiReplies(item.id).catch(() => []);
                    if (reps.length > 0) {
                        toggleRepliesBtn.style.display = "";
                        toggleRepliesBtn.textContent = `View replies (${reps.length})`;
                        // don’t pre-open; just show the button
                    }
                }
            })();

            toggleRepliesBtn.addEventListener("click", async () => {
                const open = repliesWrap.style.display !== "none";
                if (open) {
                    repliesWrap.style.display = "none";
                    const cnt = Math.max(0, repliesList.querySelectorAll(".reply").length);
                    toggleRepliesBtn.textContent = `View replies (${cnt})`;
                } else {
                    repliesWrap.style.display = "";
                    await refreshReplies(false);
                    toggleRepliesBtn.textContent = "Hide replies";
                }
            });

            actions.appendChild(toggleRepliesBtn);
        }

        /* ---------- Reply button (ONLY for top-level comments) ---------- */
        if (isTopLevel) {
            const replyBtn = document.createElement("button");
            replyBtn.className = "btn js-reply";
            replyBtn.textContent = "Reply";
            replyBtn.addEventListener("click", async () => {
                // ensure replies are visible when replying
                if (repliesWrap) {
                    repliesWrap.style.display = "";
                    // also refresh so you’re replying with context visible
                    await (async () => {
                        const reps = await apiReplies(item.id).catch(() => []);
                        repliesList.innerHTML = "";
                        if (!reps.length) {
                            const empty = document.createElement("div");
                            empty.className = "muted";
                            empty.textContent = "(No replies)";
                            repliesList.appendChild(empty);
                        } else {
                            for (const r of reps) repliesList.appendChild(renderOneReply(r, item.plea_num));
                        }
                        if (toggleRepliesBtn) toggleRepliesBtn.textContent = "Hide replies";
                        if (toggleRepliesBtn) toggleRepliesBtn.style.display = "";
                    })();
                }

                // Mount editor BENEATH the comment — i.e., after the replies block
                const mountTarget = repliesWrap || bottomAnchor;
                openInlineEditor({
                    plea_num: item.plea_num,
                    parent_id: item.id,
                    onSubmit: async (text, editor) => {
                        try {
                            await api(`/pleas/${item.plea_num}/comments`, {
                                method: "POST",
                                body: JSON.stringify({ parent_id: item.id, body: text })
                            });
                            editor.remove();
                            // Refresh + KEEP OPEN + update label
                            if (repliesWrap && repliesList) {
                                repliesWrap.style.display = "";
                                const reps = await apiReplies(item.id).catch(() => []);
                                repliesList.innerHTML = "";
                                if (!reps.length) {
                                    const empty = document.createElement("div");
                                    empty.className = "muted";
                                    empty.textContent = "(No replies)";
                                    repliesList.appendChild(empty);
                                } else {
                                    for (const r of reps) repliesList.appendChild(renderOneReply(r, item.plea_num));
                                }
                                if (toggleRepliesBtn) {
                                    toggleRepliesBtn.style.display = "";
                                    toggleRepliesBtn.textContent = "Hide replies";
                                }
                            }
                        } catch (e) { msg(e); }
                    }
                }, mountTarget);
            });
            actions.appendChild(replyBtn);
        }
        // (No Reply button at all for replies)

        // edit
        const editBtn = document.createElement("button");
        editBtn.className = "btn js-edit";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => {
            const mountTarget = (isTopLevel && repliesWrap) ? repliesWrap : bottomAnchor;
            openInlineEditor({
                initial: item.body || "",
                onSubmit: async (text, editor) => {
                    try {
                        await api(`/comments/${item.id}`, {
                            method: "PATCH",
                            body: JSON.stringify({ body: text })
                        });
                        editor.remove();
                        body.textContent = text;
                    } catch (e) { msg(e); }
                }
            }, mountTarget);
        });
        actions.appendChild(editBtn);

        // delete
        const delBtn = document.createElement("button");
        delBtn.className = "btn js-del";
        delBtn.textContent = "Delete";
        delBtn.addEventListener("click", async () => {
            if (!confirm("Delete this comment?")) return;
            try {
                await api(`/comments/${item.id}`, { method: "DELETE" });
                node.remove();
            } catch (e) { msg(e); }
        });
        actions.appendChild(delBtn);

        // assemble
        node.appendChild(actions);
        // replies + bottom anchor live at the end so the editor is always *beneath* the comment
        if (isTopLevel && repliesWrap) node.appendChild(repliesWrap);
        node.appendChild(bottomAnchor);

        container.appendChild(node);
    }

    // tiny renderer for a single reply row
    function renderOneReply(r, fallbackPleaNum) {
        const wrap = document.createElement("div");
        wrap.className = "reply";

        const body = document.createElement("div");
        body.className = "body";
        body.textContent = r.body || "";
        wrap.appendChild(body);

        const meta = document.createElement("div");
        meta.className = "muted";
        meta.textContent = new Date(r.created_at || r.timestamp || Date.now()).toLocaleString();
        wrap.appendChild(meta);

        const row = document.createElement("div");
        row.className = "actions";
        const likeBtn = document.createElement("button");
        likeBtn.className = "btn";
        likeBtn.textContent = `▲ ${r.likes | 0}`;
        const dislikeBtn = document.createElement("button");
        dislikeBtn.className = "btn";
        dislikeBtn.textContent = `▼ ${r.dislikes | 0}`;
        row.appendChild(likeBtn);
        row.appendChild(dislikeBtn);
        wrap.appendChild(row);

        const vc = makeVoteController({
            pleaNum: r.plea_num ?? fallbackPleaNum,
            id: r.id,
            likeBtn,
            dislikeBtn,
            initialUps: r.likes | 0,
            initialDowns: r.dislikes | 0,
            initialMy: 0
        });
        apiGetMyVote(r.plea_num ?? fallbackPleaNum, r.id).then(v => {
            if (v !== vc.state.my) { vc.state.my = v; vc.render(); }
        }).catch(() => { });

        return wrap;
    }

    /* ---------- activity loading ---------- */
    async function loadMore() {
        if (state.loading) return;
        state.loading = true;
        $("load-more").disabled = true;

        try {
            const j = await api(`/users/${encodeURIComponent(state.slug)}/activity?offset=${state.offset}&limit=${state.limit}`);
            state.total = j.total | 0;
            state.isOwner = !!j.is_me;

            // reflect owner status in header if it changed
            if (state.profile && state.profile.is_me !== j.is_me) {
                state.profile.is_me = j.is_me;
                renderHeader();
            }

            if (!j.items || j.items.length === 0) {
                if (state.offset === 0) $("empty").style.display = ""; // nothing at all
                $("load-more").style.display = "none";
                return;
            }
            $("empty").style.display = "none";

            // group by plea_num preserving order of the slice
            for (const item of j.items) {
                const group = ensureGroup(item.plea_num);
                renderItem(group, item);
            }

            state.offset += j.items.length;
            $("load-more").style.display = (state.offset < state.total) ? "" : "none";
        } catch (e) {
            msg(e);
        } finally {
            state.loading = false;
            $("load-more").disabled = false;
        }
    }

    function resetAndLoad() {
        state.offset = 0;
        state.total = 0;
        state.domGroups.clear();
        $("groups").innerHTML = "";
        loadMore();
    }

    /* ---------- plea titles (one fetch, cached) ---------- */
    async function loadPleaTitles() {
        try {
            const j = await api(`/plealist`);
            const arr = Array.isArray(j) ? j
                : Array.isArray(j?.items) ? j.items
                    : Array.isArray(j?.pleas) ? j.pleas
                        : [];
            for (const it of arr) {
                const id = it.id ?? it.num ?? it.plea_num ?? it.pleaId ?? it.pleaID;
                const ttl = it.title ?? it.name ?? null;
                if (id != null && ttl) state.pleaTitleMap.set(+id, String(ttl));
            }
        } catch { /* ok; fallback titles used */ }
    }

    function msg(e) {
        const m = typeof e === "string" ? e : (e?.detail || e?.message || "Error");
        $("msg").textContent = m;
        setTimeout(() => { $("msg").textContent = ""; }, 3000);
    }

    /* ---------- boot ---------- */
    async function init() {
        state.slug = extractSlugFromPath(location.pathname) || "";
        if (!state.slug) return msg("Bad URL");

        // load public profile
        const prof = await api(`/users/by-first/${encodeURIComponent(state.slug)}`).catch(() => null);
        state.profile = prof?.user || null;
        if (!state.profile) return msg("Profile not found");
        renderHeader();

        // titles & activity
        await loadPleaTitles();
        $("load-more").addEventListener("click", loadMore);
        await loadMore();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
