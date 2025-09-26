(() => {
    'use strict';

    // ---------- config/state ----------
    const state = {
        apiBase: 'http://localhost:3000/api',
        csrf: null,
        pleaNum: null,
        page: 1,
        pageSize: 3,             // ← show 3 at a time
        total: 0,
        items: [],               // append-only list as we load
        loading: false,
        open: false,
        ready: false,
    };

    // ---------- tiny utils ----------
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
    const esc = (v) => String(v ?? '');
    const plural = (n, a, b) => `${n} ${n === 1 ? a : b}`;

    // ---------- API helpers ----------
    async function getCsrf() {
        if (state.csrf) return state.csrf;
        const r = await fetch(`${state.apiBase}/csrf`, { credentials: 'include' });
        const j = await r.json();
        state.csrf = j.token;
        return j.token;
    }

    async function api(path, { method = 'GET', body, headers } = {}) {
        const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
        const opts = { method, credentials: 'include', headers: h };
        if (method !== 'GET' && method !== 'HEAD') {
            const t = await getCsrf();
            h['x-csrf-token'] = t;
        }
        if (body != null) opts.body = JSON.stringify(body);
        const res = await fetch(`${state.apiBase}${path}`, opts);
        const text = await res.text();
        let data = {};
        if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
        if (!res.ok) {
            const e = new Error(data?.error || `HTTP ${res.status}`);
            e.status = res.status; e.data = data; throw e;
        }
        return data;
    }

    async function getMe() { try { return await api('/auth/me'); } catch { return { ok: false, user: null }; } }

    // ---------- styles: Voice0 font, white text, no bg, animated toggle ----------
    function ensureStyles() {
        if (document.getElementById('dp-comments-css')) return;
        const css = `
.dp-comments{ 
  margin: 32px 0 8px; 
  color:#fff; 
  font-family:'Voice0','Montserrat',system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  opacity:0; transform:translateY(-4px);
  transition: opacity .28s ease, transform .28s ease;
}
.dp-comments.is-ready{ opacity:1; transform:none; }
.dp-c-toggle{
  cursor:pointer; user-select:none; display:inline-flex; align-items:center; gap:8px;
  font-weight:700; letter-spacing:.01em; font-size:18px;
  opacity:0; transform:translateY(-6px);
  transition: opacity .28s ease .05s, transform .28s ease .05s;
}
.dp-comments.is-ready .dp-c-toggle{ opacity:1; transform:none; }
.dp-c-toggle .chev{ display:inline-block; transition: transform .25s ease; transform: rotate(0deg); }
.dp-comments.is-open .dp-c-toggle .chev{ transform: rotate(180deg); }
.dp-c-body{
  overflow:hidden; height:0; opacity:0; transform:translateY(-6px);
  transition: height .35s ease, opacity .25s ease, transform .35s ease;
  will-change: height, opacity, transform;
}
.dp-comments.is-open .dp-c-body{ opacity:1; transform:none; }
.dp-list{ display:flex; flex-direction:column; gap:14px; }
.dp-item{
  padding: 4px 0 8px;
  border-top: 1px solid rgba(255,255,255,.08);
}
.dp-item:first-child{ border-top:none; }
.dp-meta{ color:rgba(255,255,255,.6); font-size:12px; margin-bottom:4px; display:flex; gap:.5rem; align-items:center; }
.dp-body{ white-space:pre-wrap; color:#fff; }
.dp-actions{ display:flex; gap:10px; margin-top:6px; }
.dp-btn{ 
  background:transparent; border:1px solid rgba(255,255,255,.14); 
  color:#fff; padding:6px 10px; border-radius:10px; cursor:pointer; font:inherit;
}
.dp-btn:hover{ border-color:rgba(255,255,255,.24); }
.dp-btn.is-active{ border-color:#fff; }
.dp-like-count, .dp-dislike-count{ min-width:1ch; display:inline-block; text-align:center; }
.dp-more-wrap{ margin-top:10px; display:flex; justify-content:flex-start }
.dp-more{ background:transparent; border:1px solid rgba(255,255,255,.2); color:#fff; border-radius:10px; padding:8px 12px; cursor:pointer; font:inherit; }
.dp-more[disabled]{ opacity:.5; cursor:not-allowed; }

.dp-composer{ margin:12px 0 2px; display:flex; flex-direction:column; gap:8px; }
.dp-composer textarea{
  width:100%; min-height:72px; resize:vertical;
  background:transparent; color:#fff; border:1px solid rgba(255,255,255,.2);
  border-radius:10px; padding:10px; font:inherit;
}
.dp-composer textarea::placeholder{ color:rgba(255,255,255,.5); }
.dp-composer .row{ display:flex; justify-content:flex-end; gap:8px; }
.dp-empty{ color:rgba(255,255,255,.6); font-style:italic; }
    `;
        const s = document.createElement('style');
        s.id = 'dp-comments-css';
        s.textContent = css;
        document.head.appendChild(s);
    }

    // ---------- DOM builders ----------
    function containerTemplate(total) {
        return `
      <div class="dp-c-toggle" aria-expanded="false" role="button" tabindex="0">
        <span>Comments</span>
        <span class="chev">▾</span>
        <span class="dp-count" style="opacity:.7">(${plural(total, 'comment', 'comments')})</span>
      </div>
      <div class="dp-c-body" aria-hidden="true">
        <div class="dp-composer"></div>
        <div class="dp-list"></div>
        <div class="dp-more-wrap"><button class="dp-more" type="button">View more</button></div>
      </div>
    `;
    }

    function itemTemplate(c) {
        const t = new Date(c.created_at || Date.now());
        const when = isNaN(t) ? '' : t.toLocaleString();
        const actLike = c.my_vote === 1 ? ' is-active' : '';
        const actDis = c.my_vote === -1 ? ' is-active' : '';
        return `
      <div class="dp-item" data-id="${c.id}" data-my="${c.my_vote || 0}">
        <div class="dp-meta">
          <span>by #${esc(c.user_id ?? '?')}</span>
          <span>•</span>
          <span>${esc(when)}</span>
        </div>
        <div class="dp-body">${esc(c.body || '')}</div>
        <div class="dp-actions">
          <button class="dp-btn dp-like${actLike}" type="button">
            👍 <span class="dp-like-count">${c.likes | 0}</span>
          </button>
          <button class="dp-btn dp-dislike${actDis}" type="button">
            👎 <span class="dp-dislike-count">${c.dislikes | 0}</span>
          </button>
        </div>
      </div>
    `;
    }

    // ---------- UI wiring ----------
    function slideOpen(cont, body) {
        // from 0 -> scrollHeight, then fix to 'auto' after transition
        const target = body.scrollHeight;
        body.style.height = '0px';
        requestAnimationFrame(() => { body.style.height = target + 'px'; });
        cont.classList.add('is-open');
        $('.dp-c-toggle', cont).setAttribute('aria-expanded', 'true');
        body.setAttribute('aria-hidden', 'false');
        const onEnd = (e) => {
            if (e.propertyName === 'height') {
                body.style.height = 'auto';
                body.removeEventListener('transitionend', onEnd);
            }
        };
        body.addEventListener('transitionend', onEnd);
    }

    function slideClose(cont, body) {
        // from current height (auto -> px) -> 0
        body.style.height = body.scrollHeight + 'px';
        // force reflow
        void body.offsetHeight;
        body.style.height = '0px';
        cont.classList.remove('is-open');
        $('.dp-c-toggle', cont).setAttribute('aria-expanded', 'false');
        body.setAttribute('aria-hidden', 'true');
    }

    function wireToggle(cont) {
        const toggle = $('.dp-c-toggle', cont);
        const body = $('.dp-c-body', cont);
        const doToggle = () => {
            state.open = !state.open;
            if (state.open) slideOpen(cont, body);
            else slideClose(cont, body);
        };
        toggle.addEventListener('click', doToggle);
        toggle.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doToggle(); }
        });
    }

    function wireComposer(cont) {
        const wrap = $('.dp-composer', cont);
        const btnRow = document.createElement('div'); btnRow.className = 'row';

        getMe().then(me => {
            if (me?.user?.id) {
                wrap.innerHTML = `
          <textarea placeholder="Write a comment…"></textarea>
        `;
                const post = document.createElement('button');
                post.className = 'dp-btn';
                post.type = 'button';
                post.textContent = 'Post comment';
                btnRow.appendChild(post);
                wrap.appendChild(btnRow);

                post.addEventListener('click', async () => {
                    const ta = $('textarea', wrap);
                    const text = (ta?.value || '').trim();
                    if (!text || state.loading) return;
                    post.disabled = true; state.loading = true;
                    try {
                        const j = await api(`/pleas/${encodeURIComponent(state.pleaNum)}/comments`, {
                            method: 'POST', body: { body: text }
                        });
                        ta.value = '';
                        // optimistic prepend then adjust counts
                        const c = j.comment;
                        state.items.unshift({
                            id: c.id, user_id: c.user_id, body: c.body, created_at: c.created_at,
                            likes: 0, dislikes: 0, my_vote: 0
                        });
                        state.total += 1;
                        prependItem($('.dp-list', cont), state.items[0]);
                        updateCountBadge(cont);
                    } catch (e) {
                        alert(e?.data?.error || e.message || 'Failed to post');
                    } finally {
                        state.loading = false; post.disabled = false;
                    }
                });
            } else {
                wrap.innerHTML = `
          <div class="dp-empty">Sign in to leave a comment.</div>
        `;
            }
        });
    }

    function updateCountBadge(cont) {
        const countEls = $$('.dp-count', cont);
        countEls.forEach(n => { n.textContent = `(${plural(state.total, 'comment', 'comments')})`; });
    }

    function wireVotes(el, id) {
        const likeBtn = el.querySelector('.dp-like');
        const dislikeBtn = el.querySelector('.dp-dislike');

        likeBtn?.addEventListener('click', () => {
            const my = Number(el.dataset.my || 0);
            const next = (my === 1 ? 0 : 1);
            sendVote(id, next, el);
        });

        dislikeBtn?.addEventListener('click', () => {
            const my = Number(el.dataset.my || 0);
            const next = (my === -1 ? 0 : -1);
            sendVote(id, next, el);
        });
    }

    async function sendVote(id, value, el) {
        // optimistic UI
        const likeEl = el.querySelector('.dp-like');
        const disEl = el.querySelector('.dp-dislike');
        const likeCt = el.querySelector('.dp-like-count');
        const disCt = el.querySelector('.dp-dislike-count');

        const prev = Number(el.dataset.my || 0);
        const deltaLike = (value === 1 ? 1 : 0) - (prev === 1 ? 1 : 0);
        const deltaDis = (value === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);

        likeCt.textContent = String(Math.max(0, (parseInt(likeCt.textContent || '0', 10) + deltaLike)));
        disCt.textContent = String(Math.max(0, (parseInt(disCt.textContent || '0', 10) + deltaDis)));
        el.dataset.my = String(value);
        likeEl.classList.toggle('is-active', value === 1);
        disEl.classList.toggle('is-active', value === -1);

        try {
            const j = await api(`/comments/${id}/vote`, { method: 'POST', body: { value } });
            // reconcile with server
            likeCt.textContent = String(j.likes | 0);
            disCt.textContent = String(j.dislikes | 0);
            el.dataset.my = String(j.my_vote | 0);
            likeEl.classList.toggle('is-active', j.my_vote === 1);
            disEl.classList.toggle('is-active', j.my_vote === -1);
        } catch (e) {
            // rollback
            const rollMy = prev;
            el.dataset.my = String(rollMy);
            likeEl.classList.toggle('is-active', rollMy === 1);
            disEl.classList.toggle('is-active', rollMy === -1);
            // Re-fetch this comment’s counts (optional); for now, just notify:
            console.warn('vote failed', e);
            alert(e?.data?.error || 'Vote failed');
        }
    }

    function appendItems(listEl, arr) {
        const frag = document.createDocumentFragment();
        for (const c of arr) {
            const w = document.createElement('div');
            w.innerHTML = itemTemplate(c);
            const el = w.firstElementChild;
            wireVotes(el, c.id);
            frag.appendChild(el);
        }
        listEl.appendChild(frag);
    }

    function prependItem(listEl, c) {
        const w = document.createElement('div');
        w.innerHTML = itemTemplate(c);
        const el = w.firstElementChild;
        wireVotes(el, c.id);
        listEl.insertBefore(el, listEl.firstChild);
    }

    // ---------- paging ----------
    async function loadNext(cont) {
        if (state.loading) return;
        const listEl = $('.dp-list', cont);
        const btn = $('.dp-more', cont);

        const maxPage = Math.max(1, Math.ceil(state.total / state.pageSize));
        if (state.page > maxPage && state.total > 0) { btn.disabled = true; return; }

        state.loading = true; btn.disabled = true;
        try {
            const q = new URLSearchParams({
                sort: 'hottest',
                page: String(state.page),
                page_size: String(state.pageSize),
            });
            const j = await api(`/pleas/${encodeURIComponent(state.pleaNum)}/comments?` + q.toString());
            state.total = j.total | 0;

            const items = j.items || [];
            state.items = state.items.concat(items);
            appendItems(listEl, items);

            state.page += 1;
            const maxAfter = Math.max(1, Math.ceil(state.total / state.pageSize));
            btn.disabled = state.page > maxAfter;
            updateCountBadge(cont);

            if (state.total === 0) {
                listEl.innerHTML = `<div class="dp-empty">No comments yet.</div>`;
                btn.disabled = true;
            }
        } catch (e) {
            console.error('loadNext failed', e);
            if (!state.ready) {
                // show toggle anyway
            }
        } finally {
            state.loading = false;
            if (!btn.disabled) btn.disabled = false;
        }
    }

    // ---------- main mount ----------
    async function mountComments(pleaNum, hostEl) {
        ensureStyles();
        state.pleaNum = pleaNum;

        const host = hostEl || document.createElement('div');
        host.className = 'dp-comments';
        if (!hostEl) document.body.appendChild(host);

        // initial head request to know count (page=1, size=0 would be weird, so use size=1 and just read total)
        let total = 0;
        try {
            const probe = await api(`/pleas/${encodeURIComponent(pleaNum)}/comments?` + new URLSearchParams({
                sort: 'hottest', page: '1', page_size: '1'
            }));
            total = probe.total | 0;
            state.total = total;
        } catch (e) {
            // if API down, still render a toggle so UX isn't dead
            console.warn('probe comments failed', e);
        }

        host.innerHTML = containerTemplate(total);
        wireToggle(host);
        wireComposer(host);

        // “View more” loads next page in batches of 3
        $('.dp-more', host).addEventListener('click', () => loadNext(host));

        // mark ready → fade in the toggle
        host.classList.add('is-ready');
        state.ready = true;

        // start collapsed, but available; load first page lazily when opened
        const toggle = $('.dp-c-toggle', host);
        const body = $('.dp-c-body', host);

        const lazyOpen = async () => {
            toggle.removeEventListener('click', lazyOpenOnce);
            toggle.removeEventListener('keydown', lazyKeyOnce);
            if (!state.open) { slideOpen(host, body); state.open = true; }
            // Load first page immediately on first open
            if (state.items.length === 0) {
                state.page = 1;
                await loadNext(host);
            }
        };
        const lazyOpenOnce = () => lazyOpen();
        const lazyKeyOnce = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lazyOpen(); } };

        // arm a one-time lazy loader so we don’t hit the API until user actually opens
        toggle.addEventListener('click', lazyOpenOnce, { once: true });
        toggle.addEventListener('keydown', lazyKeyOnce, { once: true });
    }

    // ---------- public API ----------
    window.DP = window.DP || {};
    window.DP.init = (opts = {}) => { if (opts.apiBase) state.apiBase = opts.apiBase; };
    window.DP.mountComments = mountComments;
    window.DP.setCommentsApiBase = (v) => { if (v) state.apiBase = v; };
})();
