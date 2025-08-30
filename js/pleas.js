document.addEventListener('DOMContentLoaded', async () => {
    const listEl = document.getElementById('plea-list');
    if (!listEl) return;

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

    let centerRAF = null;

    function cancelCentering() {
        if (centerRAF) {
            cancelAnimationFrame(centerRAF);
            centerRAF = null;
        }
    }

    // Gently nudge the chosen element to true center without overshoot
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
    function scheduleVisuals() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => { rafPending = false; updateVisuals(); });
    }

    // -------- build list (stable DOM order, then hydrate titles) --------
    {
        const frag = document.createDocumentFragment();
        urls.forEach(({ num, url }) => {
            const a = document.createElement('a');
            a.href = url;
            a.className = 'plea-card';
            a.innerHTML = `<div class="plea-title">Plea #${num}</div>`;
            a.style.setProperty('--intro-mult', '0');
            a.style.setProperty('--rest-op', '0'); // prevent 1-frame flash
            frag.appendChild(a);
            cards.push(a);
        });
        listEl.appendChild(frag);

        // hydrate titles without changing DOM order
        urls.forEach(({ url }, idx) => {
            fetchPleaTitle(url).then(title => {
                const el = cards[idx].querySelector('.plea-title') || cards[idx];
                el.textContent = title || el.textContent;
                scheduleVisuals();
            }).catch(() => { });
        });
    }

    // -------- center first at rest --------
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

    // -------- intro tween (0 -> 1) --------
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

    function sequentialRevealAllTopToBottom() {
        if (!cards.length) return;
        const ordered = cards
            .map((c, idx) => ({ c, top: c.offsetTop, idx }))
            .sort((a, b) => (a.top - b.top) || (a.idx - b.idx))
            .map(x => x.c);

        let t = 0;
        let gap = 420;
        const factor = 0.68;

        ordered.forEach(card => {
            tweenIntro(card, 550, t);
            t += gap;
            gap *= factor;
        });
    }

    // ======== CONTINUOUS SCALE/OPACITY (NO SNAPS) ========
    const MIN_SCALE = 0.22;
    const MAX_OP = 0.50;
    const MIN_OP = 0.06;
    const BASE_VH = 900;
    const K_VIEW_CLAMP = [0.6, 1.6];

    function viewMult(vh) {
        let m = vh / BASE_VH;
        return Math.min(K_VIEW_CLAMP[1], Math.max(K_VIEW_CLAMP[0], m));
    }

    function peakTail(d, vh, A = 0.25, k = 0.5, alpha = 0.20) {
        const m = viewMult(vh);
        const peak = Math.exp(-(k * m) * d * d);
        const tail = 1 / (1 + (alpha * m) * Math.sqrt(d || 0));
        return A * peak + (1 - A) * tail;
    }

    function peakTailLog(d, vh, A = 0.75, k = 0.75, alpha = 0.15) {
        const m = viewMult(vh);
        const peak = Math.exp(-(k * m) * d * d);
        const tail = 1 / (1 + (alpha * m) * Math.log1p(Math.sqrt(d || 0)));
        return A * peak + (1 - A) * tail;
    }

    function median(nums) {
        if (!nums.length) return 0;
        const s = nums.slice().sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }

    function estimateStepPx() {
        if (cards.length < 2) return cards[0]?.offsetHeight || 80;
        const centers = cards.map(c => c.offsetTop + c.offsetHeight / 2);
        const diffs = [];
        for (let i = 1; i < centers.length; i++) {
            const d = centers[i] - centers[i - 1];
            if (d > 4 && d < 2000) diffs.push(d);
        }
        const m = median(diffs);
        return m || (cards[0]?.offsetHeight || 80);
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

    // ======== snapping (idle) + inputs (wheel/keys) ========
    const SNAP_DELAY = 10;
    const SCROLL_IDLE = 10;

    let ticking = false;
    let snapTimer = null;
    let scrollIdleTimer = null;
    let pointerDown = false;
    let scrolling = false;
    let navigating = false;

    function centeredIndex() {
        const vh = Math.max(1, window.innerHeight);
        const cy = vh / 2;
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
        snapTimer = setTimeout(() => {
            if (pointerDown || scrolling || navigating) return;
            snapToNearest();
        }, delay);
    }

    function onScroll() {
        if (!ticking) {
            ticking = true;
            requestAnimationFrame(() => { ticking = false; updateVisuals(); });
        }
        scrolling = true;
        clearTimeout(scrollIdleTimer);
        scrollIdleTimer = setTimeout(() => { scrolling = false; scheduleSnap(); }, SCROLL_IDLE);
        clearTimeout(snapTimer);
    }

    function snapToNearest() { scrollToIndex(centeredIndex()); }

    function scrollToIndex(idx) {
        idx = Math.max(0, Math.min(cards.length - 1, idx));
        const el = cards[idx].querySelector('.plea-title') || cards[idx];
        centerOn(el);
    }

    function snapToNearest() {
        const i = centeredIndex();
        const el = cards[i]?.querySelector('.plea-title') || cards[i];
        if (el) centerOn(el);
    }

    document.addEventListener('pointerdown', () => {
        cancelCentering();
    }, { passive: true });

    window.addEventListener('wheel', (e) => {
        if (!e.ctrlKey) cancelCentering();
        // …your existing wheel step code stays...
    }, { passive: false });

    function stepTo(delta) { scrollToIndex(centeredIndex() + delta); }

    // Wheel: 1 notch => 1 item
    let wheelAccum = 0;
    const WHEEL_THRESH = 60;
    window.addEventListener('wheel', (e) => {
        if (e.ctrlKey) return; // allow pinch zoom
        e.preventDefault();
        const unit = (e.deltaMode === 1) ? 16 : (e.deltaMode === 2) ? window.innerHeight : 1;
        wheelAccum += e.deltaY * unit;
        if (Math.abs(wheelAccum) >= WHEEL_THRESH) {
            const dir = wheelAccum > 0 ? 1 : -1;
            wheelAccum = 0;
            stepTo(dir);
        }
    }, { passive: false });

    // Keyboard
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); stepTo(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); stepTo(-1); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            const i = centeredIndex();
            if (cards[i]) window.location.href = cards[i].href;
        }
    });

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', () => { updateVisuals(); scheduleSnap(); }, { passive: true });

    document.addEventListener('pointerdown', () => { pointerDown = true; clearTimeout(snapTimer); }, { passive: true });
    document.addEventListener('pointerup', () => { pointerDown = false; if (!scrolling && !navigating) scheduleSnap(); }, { passive: true });

    // first pass
    updateVisuals();
    setTimeout(() => {
        applyCenterBuffer();
        sequentialRevealAllTopToBottom(); // reveal everything top→bottom, including offscreen
        updateVisuals();
        scheduleSnap();
    }, 160);
});
