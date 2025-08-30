// /pleas/ (selector)
document.addEventListener('DOMContentLoaded', async () => {
    const listEl = document.getElementById('plea-list');
    if (!listEl) return;

    // ---- simple progress store ----
    const KEY = n => `plea-progress:${n}`;
    function readProgress(n) {
        try { return JSON.parse(localStorage.getItem(KEY(n)) || 'null'); }
        catch { return null; }
    }

    // ---- return target (from reader) ----
    const RETURN_KEY = 'plea:return';
    function consumeReturnNum() {
        // prefer sessionStorage set by reader, but also allow ?return=123 or #123
        let n = sessionStorage.getItem(RETURN_KEY);
        if (!n) {
            const sp = new URLSearchParams(location.search);
            n = sp.get('return') || sp.get('r');
            if (!n && location.hash) {
                const m = location.hash.match(/#(\d{1,6})$/);
                if (m) n = m[1];
            }
        }
        if (n && /^\d+$/.test(n)) {
            sessionStorage.removeItem(RETURN_KEY);
            return parseInt(n, 10);
        }
        return null;
    }
    const returnNum = consumeReturnNum();

    // inject minimal styles for status colors
    (function injectStyles() {
        const css = `
        .plea-card{
            background: none;
            color: inherit;
            transition: color .2s, filter .2s;
        }
        .plea-card .plea-title{ color: inherit; }

        /* in-progress = amber text */
        .plea-card.is-inprogress,
        .plea-card.is-inprogress:link,
        .plea-card.is-inprogress:visited{
            color: #D9D38D;
        }

        /* done = bright yellow text + subtle desat */
        .plea-card.is-done,
        .plea-card.is-done:link,
        .plea-card.is-done:visited{
            color: #FFFFFF;
        }
        `;
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
    })();

    // -------- sitemap -> numbered URLs --------
    async function getPleaUrlsFromSitemap() {
        try {
            const res = await fetch('/sitemap.xml', { cache: 'no-cache' });
            const xml = await res.text();
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            const locs = [...doc.querySelectorAll('url > loc')].map(n => n.textContent || '');
            return locs
                .map(u => {
                    const m = u.match(/\/(\d+)\/?$/);
                    return m ? { num: Number(m[1]), url: `/${m[1]}/` } : null;
                })
                .filter(Boolean)
                .sort((a, b) => b.num - a.num);
        } catch {
            return [];
        }
    }

    // -------- get display title (strip leading "Plea ") --------
    async function fetchPleaTitle(u) {
        try {
            const res = await fetch(u, { cache: 'no-store' });
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const raw = (doc.querySelector('.plea-number')?.textContent?.trim() || doc.title || u).trim();
            return raw.replace(/^\s*plea\s*[:#-]?\s*/i, '').trim();
        } catch {
            return u;
        }
    }

    const urls = await getPleaUrlsFromSitemap();
    const cards = [];

    // build in stable DOM order, then hydrate titles, then apply status colors
    {
        const frag = document.createDocumentFragment();
        urls.forEach(({ num, url }) => {
            const a = document.createElement('a');
            a.href = url;
            a.className = 'plea-card';
            a.dataset.pleaNum = String(num);
            a.innerHTML = `<div class="plea-title">Plea #${num}</div>`;
            a.style.setProperty('--intro-mult', '0');
            a.style.setProperty('--rest-op', '0');
            frag.appendChild(a);
            cards.push(a);
        });
        listEl.appendChild(frag);

        // hydrate titles in-place
        urls.forEach(({ url }, idx) => {
            fetchPleaTitle(url).then(title => {
                const el = cards[idx].querySelector('.plea-title') || cards[idx];
                el.textContent = title || el.textContent;
            }).catch(() => { });
        });

        // apply status classes from localStorage
        urls.forEach(({ num }, idx) => {
            const p = readProgress(num);
            const card = cards[idx];
            card.classList.remove('is-inprogress', 'is-done');
            if (p?.done) {
                card.classList.add('is-done');
                card.title = 'Finished';
            } else if (Number.isFinite(p?.lastIndex) && p.lastIndex > 0) {
                card.classList.add('is-inprogress');
                card.title = 'In progress — resume where you left off';
            } else {
                card.title = 'New';
            }
        });
    }

    // === visuals / snap ===
    let centerRAF = null;
    function cancelCentering() { if (centerRAF) { cancelAnimationFrame(centerRAF); centerRAF = null; } }
    function centerOn(el) {
        cancelCentering();
        const cy = window.innerHeight / 2;
        function tick() {
            const r = el.getBoundingClientRect();
            const delta = (r.top + r.height / 2) - cy;
            if (Math.abs(delta) <= 0.6) { centerRAF = null; return; }
            window.scrollBy(0, delta * 0.1);
            centerRAF = requestAnimationFrame(tick);
        }
        centerRAF = requestAnimationFrame(tick);
    }
    let rafPending = false;
    function scheduleVisuals() { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; updateVisuals(); }); }

    function applyCenterBuffer() {
        if (!cards.length) return;
        const firstTitle = cards[0].querySelector('.plea-title') || cards[0];
        const rect = firstTitle.getBoundingClientRect();
        const h = rect.height || 0;
        const topPad = Math.max(0, (window.innerHeight / 2) - (h / 2));
        listEl.style.paddingTop = `${topPad}px`;
        listEl.style.paddingBottom = `${Math.max(0, window.innerHeight / 2)}px`;
    }
    applyCenterBuffer();
    window.addEventListener('resize', applyCenterBuffer, { passive: true });

    function tweenIntro(card, dur = 550, delay = 0) {
        const startAt = performance.now() + delay;
        function step(now) {
            const t = (now - startAt) / dur;
            if (t < 0) { requestAnimationFrame(step); return; }
            const v = Math.min(1, Math.max(0, t));
            const eased = v * v * (3 - 2 * v);
            card.style.setProperty('--intro-mult', eased.toFixed(3));
            scheduleVisuals();
            if (v < 1) requestAnimationFrame(step);
            else { card.style.setProperty('--intro-mult', '1'); scheduleVisuals(); }
        }
        requestAnimationFrame(step);
    }

    // NEW: outward reveal from a chosen start index (center, then ±1, ±2, …)
    function revealOutwardFrom(startIdx) {
        if (!cards.length) return;
        const order = [];
        order.push(startIdx);
        for (let d = 1; (startIdx - d >= 0) || (startIdx + d < cards.length); d++) {
            if (startIdx + d < cards.length) order.push(startIdx + d);
            if (startIdx - d >= 0) order.push(startIdx - d);
        }
        let t = 0, gap = 420, factor = 0.68;
        order.forEach(i => { tweenIntro(cards[i], 550, t); t += gap; gap *= factor; });
    }

    // falloff + snapping (keeps your current constants)
    const MIN_SCALE = 0.22, MAX_OP = 0.75, MIN_OP = 0.06, BASE_VH = 900, K_VIEW_CLAMP = [0.6, 1.6];
    const viewMult = vh => Math.min(K_VIEW_CLAMP[1], Math.max(K_VIEW_CLAMP[0], vh / BASE_VH));
    function peakTail(d, vh, A = 0.25, k = 0.5, a = 0.20) { const m = viewMult(vh); return A * Math.exp(-(k * m) * d * d) + (1 - A) * (1 / (1 + (a * m) * Math.sqrt(d || 0))); }
    function peakTailLog(d, vh, A = 0.35, k = 0.75, a = 0.15) { const m = viewMult(vh); return A * Math.exp(-(k * m) * d * d) + (1 - A) * (1 / (1 + (a * m) * Math.log1p(Math.sqrt(d || 0)))); }
    function median(arr) { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
    function estimateStepPx() {
        if (cards.length < 2) return cards[0]?.offsetHeight || 80;
        const centers = cards.map(c => c.offsetTop + c.offsetHeight / 2);
        const diffs = []; for (let i = 1; i < centers.length; i++) { const d = centers[i] - centers[i - 1]; if (d > 4 && d < 2000) diffs.push(d); }
        return median(diffs) || (cards[0]?.offsetHeight || 80);
    }
    function updateVisuals() {
        if (!cards.length) return;
        const pageY = (window.pageYOffset || document.documentElement.scrollTop);
        const vh = Math.max(1, window.innerHeight);
        const pageCenter = pageY + vh / 2;
        const stepPx = estimateStepPx();
        for (const card of cards) {
            const elCenter = card.offsetTop + card.offsetHeight / 2;
            const dItems = Math.abs(elCenter - pageCenter) / stepPx;
            const relS = peakTail(dItems, vh);
            const s = MIN_SCALE + (1 - MIN_SCALE) * relS;
            const relO = peakTailLog(dItems, vh);
            const baseOp = MIN_OP + (MAX_OP - MIN_OP) * relO;
            const gate = parseFloat(card.style.getPropertyValue('--intro-mult')) || 0;
            const op = baseOp * gate;
            card.style.setProperty('--scale', s.toFixed(3));
            card.style.setProperty('--rest-op', op.toFixed(3));
        }
    }

    const SNAP_DELAY = 10, SCROLL_IDLE = 10;
    let ticking = false, snapTimer = null, scrollIdleTimer = null, pointerDown = false, scrolling = false, navigating = false;
    function centeredIndex() {
        const vh = Math.max(1, window.innerHeight), cy = vh / 2;
        let best = 0, bestDist = Infinity;
        for (let idx = 0; idx < cards.length; idx++) {
            const el = cards[idx].querySelector('.plea-title') || cards[idx];
            const r = el.getBoundingClientRect();
            const c = r.top + r.height / 2;
            const d = Math.abs(c - cy);
            if (d < bestDist) { bestDist = d; best = idx; }
        }
        return best;
    }
    function scheduleSnap(delay = SNAP_DELAY) {
        if (pointerDown || scrolling || navigating) return;
        clearTimeout(snapTimer);
        snapTimer = setTimeout(() => { if (pointerDown || scrolling || navigating) return; snapToNearest(); }, delay);
    }
    function onScroll() {
        if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; updateVisuals(); }); }
        scrolling = true;
        clearTimeout(scrollIdleTimer);
        scrollIdleTimer = setTimeout(() => { scrolling = false; scheduleSnap(); }, SCROLL_IDLE);
        clearTimeout(snapTimer);
    }
    function scrollToIndex(idx) {
        idx = Math.max(0, Math.min(cards.length - 1, idx));
        const el = cards[idx].querySelector('.plea-title') || cards[idx];
        centerOn(el);
    }
    function snapToNearest() { scrollToIndex(centeredIndex()); }

    document.addEventListener('pointerdown', () => { cancelCentering(); }, { passive: true });
    window.addEventListener('wheel', (e) => { if (!e.ctrlKey) cancelCentering(); }, { passive: false });

    function stepTo(delta) { scrollToIndex(centeredIndex() + delta); }

    let wheelAccum = 0; const WHEEL_THRESH = 60;
    window.addEventListener('wheel', (e) => {
        if (e.ctrlKey) return;
        e.preventDefault();
        const unit = (e.deltaMode === 1) ? 16 : (e.deltaMode === 2) ? window.innerHeight : 1;
        wheelAccum += e.deltaY * unit;
        if (Math.abs(wheelAccum) >= WHEEL_THRESH) {
            const dir = wheelAccum > 0 ? 1 : -1;
            wheelAccum = 0;
            stepTo(dir);
        }
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); stepTo(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); stepTo(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); const i = centeredIndex(); if (cards[i]) window.location.href = cards[i].href; }
    });

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => { updateVisuals(); scheduleSnap(); }, { passive: true });

    document.addEventListener('pointerdown', () => { pointerDown = true; clearTimeout(snapTimer); }, { passive: true });
    document.addEventListener('pointerup', () => { pointerDown = false; if (!scrolling && !navigating) scheduleSnap(); }, { passive: true });

    // ---- initialize: center on return card (if any), then reveal outward ----
    function findIndexByNum(num) {
        if (!Number.isFinite(num)) return -1;
        for (let i = 0; i < cards.length; i++) {
            if ((cards[i].dataset.pleaNum | 0) === num) return i;
        }
        return -1;
    }

    updateVisuals();
    setTimeout(() => {
        applyCenterBuffer();

        // pick start index
        let startIdx = 0;
        const idxFromNum = findIndexByNum(returnNum);
        if (idxFromNum >= 0) {
            // hard-center immediately (no gentle nudge for initial position)
            const el = cards[idxFromNum].querySelector('.plea-title') || cards[idxFromNum];
            const r = el.getBoundingClientRect();
            const targetY = (r.top + window.pageYOffset) - (window.innerHeight / 2 - r.height / 2);
            window.scrollTo(0, Math.max(0, targetY));
            startIdx = idxFromNum;
        } else {
            startIdx = centeredIndex();
        }

        // reveal from the start index outward (both directions)
        revealOutwardFrom(startIdx);

        updateVisuals();
        scheduleSnap();

        // gently “lock” perfect center (only if we had a specific target)
        if (idxFromNum >= 0) {
            const el = cards[idxFromNum].querySelector('.plea-title') || cards[idxFromNum];
            setTimeout(() => centerOn(el), 0);
        }
    }, 160);
});
