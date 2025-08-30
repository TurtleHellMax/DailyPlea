// plea page (reader)
document.addEventListener('DOMContentLoaded', () => {
    // ---- progress store (per-plea) ----
    function currentPleaNumber() {
        const m = location.pathname.match(/\/(\d{1,6})\/?$/);
        if (m) return parseInt(m[1], 10);
        const t = document.querySelector('.plea-number')?.textContent || '';
        const n = t.match(/Plea\s*#\s*(\d+)/i);
        return n ? parseInt(n[1], 10) : null;
    }

    function beginFirstRevealIfNeeded() {
        if (firstRevealStarted) return false;
        firstRevealStarted = true;
        revealSection(current);
        current++;
        return true;
    }

    const RETURN_KEY = 'plea:return';

    // helper
    function stashReturnTarget() {
        if (PLEA_NUM) sessionStorage.setItem(RETURN_KEY, String(PLEA_NUM));
    }

    let firstRevealStarted = false;
    let uiUnlocked = false; // <— NEW: block inputs until overlay is done

    const PLEA_NUM = currentPleaNumber();
    const KEY = PLEA_NUM ? `plea-progress:${PLEA_NUM}` : null;

    function readProgress() {
        if (!KEY) return null;
        try { return JSON.parse(localStorage.getItem(KEY) || 'null'); }
        catch { return null; }
    }
    function writeProgress(obj) {
        if (!KEY) return;
        try { localStorage.setItem(KEY, JSON.stringify({ ...obj, updatedAt: new Date().toISOString() })); }
        catch { }
    }
    function clearLastIndexKeepDone() {
        const p = readProgress() || {};
        writeProgress({ done: !!p.done, lastIndex: undefined });
    }

    (function addPleaHubButton() {
        const HUB_URL = '/pleas/';
        const ICON_SRC = '/icons/plea-hub.png';
        const a = document.createElement('a');
        a.href = HUB_URL;
        a.className = 'plea-hub-btn';
        a.setAttribute('aria-label', 'Open Plea Select');
        const img = new Image();
        img.src = ICON_SRC; img.alt = 'Plea Select'; img.decoding = 'async'; img.loading = 'eager'; img.draggable = false;
        a.appendChild(img); document.body.appendChild(a);
        a.addEventListener('click', () => { stashReturnTarget(); }, { capture: true });
        requestAnimationFrame(() => a.classList.add('is-show'));
    })();

    const cfg = (() => {
        const dataHum = document.body?.dataset?.hum;
        const dataThr = document.body?.dataset?.clickThrottle;
        const metaHum = document.querySelector('meta[name="dp:hum"]')?.content;
        const metaThr = document.querySelector('meta[name="dp:click_throttle"]')?.content;
        let hum = dataHum || metaHum || 'Voice0Hum.wav';
        if (!/^https?:\/\//i.test(hum) && !hum.startsWith('/')) hum = '/sounds/' + hum;
        let throttle = parseInt(dataThr || metaThr || '50', 10);
        if (!Number.isFinite(throttle)) throttle = 50;
        return { HUM_SRC: hum, CLICK_THROTTLE: throttle };
    })();

    const sections = document.querySelectorAll('.container .section');
    const animateSections = Array.from(sections).slice(1);
    const prompt = document.getElementById('continue-prompt');
    const container = document.querySelector('.container');
    container.scrollTo({ top: 0, behavior: 'auto' });

    const startOverlay = document.getElementById('start-overlay');
    if (startOverlay) { startOverlay.setAttribute('tabindex', '0'); setTimeout(() => startOverlay.focus({ preventScroll: true }), 0); }
    const startText = document.getElementById('start-text');
    const ellipsis = document.getElementById('ellipsis');

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const volumeNode = audioCtx.createGain();
    volumeNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
    volumeNode.connect(audioCtx.destination);

    let clickBuffer = null, resumed = false, started = false, lastClickTime = 0;

    fetch(cfg.HUM_SRC)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} for audio`); return r.arrayBuffer(); })
        .then(data => audioCtx.decodeAudioData(data))
        .then(buf => { clickBuffer = buf; })
        .catch(err => console.error('Audio load failed:', err));

    requestAnimationFrame(() => startText?.classList.add('visible'));

    function playClick() {
        if (!clickBuffer || !resumed) return;
        const now = performance.now();
        if (now - lastClickTime < cfg.CLICK_THROTTLE) return;
        lastClickTime = now;
        const src = audioCtx.createBufferSource();
        src.buffer = clickBuffer; src.connect(volumeNode); src.start();
    }

    // wrap every char in spans
    animateSections.forEach(section => {
        const raw = section.textContent;
        section.textContent = '';
        Array.from(raw).forEach(ch => {
            if (ch === ' ') {
                section.appendChild(document.createTextNode(' '));
            } else {
                const span = document.createElement('span');
                span.textContent = ch;
                span.className = 'char';
                section.appendChild(span);
            }
        });
    });

    let current = 0;
    let revealing = false;
    let timeouts = [];
    let promptTimer = null;

    const hidePrompt = () => {
        clearTimeout(promptTimer);
        if (prompt) prompt.classList.remove('visible');
    };

    const schedulePrompt = idx => {
        clearTimeout(promptTimer);
        const delay = idx === 0 ? 2500 : 6000;
        promptTimer = setTimeout(() => prompt.classList.add('visible'), delay);
    };

    // ===== progress-aware helpers =====
    const progress0 = readProgress();
    const PROGRESS_LOCKED_DONE = !!progress0?.done;
    const RESUME_INDEX = (!PROGRESS_LOCKED_DONE && Number.isFinite(progress0?.lastIndex))
        ? Math.max(0, Math.min(animateSections.length, progress0.lastIndex | 0))
        : 0;

    function markProgressAfterSection(idx) {
        if (!KEY || PROGRESS_LOCKED_DONE) return;
        const FINAL_IDX = animateSections.length - 2;
        if (idx >= FINAL_IDX) {
            writeProgress({ done: true });
            return;
        }
        const next = Math.max(0, Math.min(animateSections.length, idx + 1));
        writeProgress({ done: false, lastIndex: next });
    }

    function preRevealUpTo(idx) {
        for (let i = 0; i < idx; i++) {
            const chars = animateSections[i]?.querySelectorAll('.char') || [];
            chars.forEach(c => c.classList.add('visible'));
        }
        const prev = animateSections[idx - 1];
        if (prev) {
            const gutter = container.clientHeight * 0.2;
            const target = Math.max(0, prev.offsetTop - gutter);
            container.scrollTo({ top: target, behavior: 'auto' });
        }
        revealing = false;
        if (idx > 0) schedulePrompt(idx - 1);
    }

    const revealSection = idx => {
        revealing = true;
        const chars = animateSections[idx].querySelectorAll('.char');
        const BASE_SPEED = 30, PERIOD_PAUSE = 300, COMMA_PAUSE = 150;
        let accDelay = 0;

        timeouts.forEach(clearTimeout);
        timeouts = [];

        chars.forEach(c => {
            const id = setTimeout(() => {
                const ch = c.textContent;
                if (ch.trim() !== '') playClick();
                c.classList.add('visible');

                const gutter = container.clientHeight * 0.2;
                const charBottom = c.offsetTop + c.clientHeight;
                const visibleBottom = container.scrollTop + container.clientHeight - gutter;
                if (charBottom > visibleBottom) {
                    const target = charBottom - (container.clientHeight - gutter);
                    container.scrollTo({ top: target, behavior: 'smooth' });
                }

                if (c === chars[chars.length - 1]) onSectionComplete(idx);
            }, accDelay);

            timeouts.push(id);
            accDelay += BASE_SPEED;
            if (c.textContent === '.' || c.textContent === '!' || c.textContent === '?' || c.textContent === ':' || c.textContent === ';') accDelay += PERIOD_PAUSE;
            if (c.textContent === ',' || c.textContent === '"') accDelay += COMMA_PAUSE;
        });
    };

    function onSectionComplete(idx) {
        revealing = false;
        markProgressAfterSection(idx);
        const FINAL_IDX = animateSections.length - 2;

        if (idx < FINAL_IDX) {
            schedulePrompt(idx);
        } else if (idx === FINAL_IDX) {
            try {
                gtag('event', 'all_text_revealed', {
                    event_category: 'engagement',
                    event_label: 'full_text'
                });
            } catch { }
            fetch('https://text-reveal-worker.dupeaccmax.workers.dev/', { method: 'POST', mode: 'cors' })
                .then(r => r.json())
                .then(data => console.log('Beacon transmitted', data.count, 'times'))
                .catch(console.error);
        }
    }

    async function doStartFlow() {
        // “Connecting…”
        startText.textContent = 'Connecting';
        ellipsis.textContent = '';
        for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 300));
            ellipsis.textContent += '.';
        }
        await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));
        startText.textContent = '';
        ellipsis.textContent = '';
        await new Promise(r => setTimeout(r, 1000));
        startOverlay.classList.add('hidden');
        await new Promise(r => setTimeout(r, 1000));

        // UNLOCK inputs ONLY now
        uiUnlocked = true;

        // resume or start fresh
        if (!PROGRESS_LOCKED_DONE && RESUME_INDEX > 0) {
            preRevealUpTo(RESUME_INDEX);
            current = RESUME_INDEX;
        } else {
            beginFirstRevealIfNeeded();
            if (PROGRESS_LOCKED_DONE) clearLastIndexKeepDone();
        }
    }

    function onStart(e) {
        e.preventDefault();
        if (started) return;
        started = true;
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(console.error);
        resumed = true;
        doStartFlow();
    }

    function finishCurrentSection() {
        if (!revealing) return false;
        timeouts.forEach(clearTimeout);
        const idx = current - 1;
        animateSections[idx]?.querySelectorAll('.char')?.forEach(c => c.classList.add('visible'));
        onSectionComplete(idx);
        return true;
    }

    // inputs
    startOverlay.addEventListener('pointerdown', onStart, { once: true });
    startOverlay.addEventListener('touchstart', onStart, { once: true, passive: false });
    startOverlay.addEventListener('click', onStart, { once: true });

    container.addEventListener('click', () => {
        if (!started || !uiUnlocked) return;  // <— block until overlay done
        hidePrompt();
        if (current >= animateSections.length) return;

        if (!firstRevealStarted) {            // start first reveal only
            beginFirstRevealIfNeeded();
            return;
        }
        if (finishCurrentSection()) return;   // finish current if mid-reveal

        revealSection(current);               // advance to next
        current++;
    });

    // Keyboard: Esc -> hub; Enter -> start/advance
    (() => {
        const hubHref = document.querySelector('.plea-hub-btn')?.href || '/pleas/';
        function keyHandler(e) {
            const tag = (e.target?.tagName || '').toLowerCase();
            if (['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable) return;
            if (e.repeat) return;

            const onceFlag = '__pleaHandled';
            if (e[onceFlag]) return;
            e[onceFlag] = true;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            if (e.key === 'Escape' || e.key === 'Esc') {
                stashReturnTarget();
                window.location.assign(hubHref);
                return;
            }
            if (e.key === 'Enter') {
                if (!started) { onStart(e); return; }     // kick off overlay flow
                if (!uiUnlocked) return;                  // <— ignore until unlocked
                hidePrompt();
                if (current >= animateSections.length) return;

                if (!firstRevealStarted) {                // start first reveal only
                    beginFirstRevealIfNeeded();
                    return;
                }
                if (finishCurrentSection()) return;       // finish current if mid-reveal

                revealSection(current);                   // advance to next
                current++;
            }
        }
        window.addEventListener('keydown', keyHandler, { capture: true });
    })();
});
