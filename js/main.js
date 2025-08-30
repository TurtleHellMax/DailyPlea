document.addEventListener('DOMContentLoaded', () => {
    (
        function addPleaHubButton()
        {
            const HUB_URL = '/pleas/';             // change to your selector page path
            const ICON_SRC = '/icons/plea-hub.png'; // your pixel PNG (root-absolute)

            const a = document.createElement('a');
            a.href = HUB_URL;
            a.className = 'plea-hub-btn';
            a.setAttribute('aria-label', 'Open Plea Select');

            const img = new Image();
            img.src = ICON_SRC;
            img.alt = 'Plea Select';
            img.decoding = 'async';
            img.loading = 'eager';
            img.draggable = false;

            a.appendChild(img);
            document.body.appendChild(a);

            // fade in after it’s in the DOM
            requestAnimationFrame(() => a.classList.add('is-show'));
        }
    )();

    const cfg = (() => {
        const dataHum = document.body?.dataset?.hum;
        const dataThr = document.body?.dataset?.clickThrottle;

        const metaHum = document.querySelector('meta[name="dp:hum"]')?.content;
        const metaThr = document.querySelector('meta[name="dp:click_throttle"]')?.content;

        let hum = dataHum || metaHum || 'Voice0Hum.wav';
        if (!/^https?:\/\//i.test(hum) && !hum.startsWith('/')) {
            hum = '/sounds/' + hum;
        }

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

    if (startOverlay) {
        startOverlay.setAttribute('tabindex', '0');
        // next-tick focus so the DOM is fully ready
        setTimeout(() => startOverlay.focus({ preventScroll: true }), 0);
    }

    const startText = document.getElementById('start-text');
    const ellipsis = document.getElementById('ellipsis');

    const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const volumeNode = audioCtx.createGain();
    volumeNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
    volumeNode.connect(audioCtx.destination);

    let clickBuffer = null;
    let resumed = false;
    let started = false;
    let lastClickTime = 0;

    fetch(cfg.HUM_SRC)
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status} for audio`);
            return r.arrayBuffer();
        })
        .then(data => audioCtx.decodeAudioData(data))
        .then(buf => { clickBuffer = buf; })
        .catch(err => console.error('Audio load failed:', err));

    requestAnimationFrame(() => {
        startText?.classList.add('visible');
    });

    function playClick() {
        if (!clickBuffer || !resumed) return;
        const now = performance.now();
        // EDIT #2: use cfg.CLICK_THROTTLE
        if (now - lastClickTime < cfg.CLICK_THROTTLE) return;
        lastClickTime = now;

        const src = audioCtx.createBufferSource();
        src.buffer = clickBuffer;
        src.connect(volumeNode);
        src.start();
    }

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

    const revealSection = idx => {
        revealing = true;
        const chars = animateSections[idx].querySelectorAll('.char');
        const BASE_SPEED = 30;
        const PERIOD_PAUSE = 300;
        const COMMA_PAUSE = 150;
        let accDelay = 0;

        timeouts.forEach(clearTimeout);
        timeouts = [];

        chars.forEach(c => {
            const id = setTimeout(() => {
                const ch = c.textContent;
                if (ch.trim() !== '') {
                    playClick();
                }
                c.classList.add('visible');

                const gutter = container.clientHeight * 0.2;
                const charBottom = c.offsetTop + c.clientHeight;
                const visibleBottom = container.scrollTop + container.clientHeight - gutter;
                if (charBottom > visibleBottom) {
                    const target = charBottom - (container.clientHeight - gutter);
                    container.scrollTo({ top: target, behavior: 'smooth' });
                }

                if (c === chars[chars.length - 1]) {
                    onSectionComplete(idx);
                }
            }, accDelay);

            timeouts.push(id);
            accDelay += BASE_SPEED;
            if (c.textContent === '.' || c.textContent === '!' || c.textContent === '?' || c.textContent === ':' || c.textContent === ';') accDelay += PERIOD_PAUSE;

            if (c.textContent === ',' || c.textContent === '"') accDelay += COMMA_PAUSE;
        });
    };

    async function doStartFlow() {
        // switch text to “Connecting” and clear old ellipses
        startText.textContent = 'Connecting';
        ellipsis.textContent = '';

        // add dots one by one
        for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 300));
            ellipsis.textContent += '.';
        }

        // random pause before hiding
        await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));

        // clear everything, wait, then hide overlay
        startText.textContent = '';
        ellipsis.textContent = '';
        await new Promise(r => setTimeout(r, 1000));
        startOverlay.classList.add('hidden');

        // then wait and start the first reveal
        await new Promise(r => setTimeout(r, 1000));
        revealSection(0);
        current = 1;
    }

    function onStart(e) {
        e.preventDefault();
        if (started) return; 
        started = true; 

        if (audioCtx.state === 'suspended') audioCtx.resume().catch(console.error);
        resumed = true;
        doStartFlow();
    }

    function onSectionComplete(idx) {
        revealing = false;
        if (idx < animateSections.length - 2) {
            schedulePrompt(idx);
        } else if (idx === animateSections.length - 2) {
            // <-- this was the final section
            gtag('event', 'all_text_revealed', {
                event_category: 'engagement',
                event_label: 'full_text'
            });
            fetch('https://text-reveal-worker.dupeaccmax.workers.dev/', {
                method: 'POST', mode: 'cors'
            })
                .then(r => r.json())
                .then(data => console.log('Beacon transmitted', data.count, 'times'))
                .catch(console.error);
        }
    }

    // fast-forward the *current* section only; return true if we did so
    function finishCurrentSection() {
        if (!revealing) return false;
        timeouts.forEach(clearTimeout);
        const idx = current - 1; // the section that’s mid-reveal
        animateSections[idx]
            ?.querySelectorAll('.char')
            .forEach(c => c.classList.add('visible'));
        onSectionComplete(idx);
        return true;
    }

    startOverlay.addEventListener('pointerdown', onStart, { once: true });
    startOverlay.addEventListener('touchstart', onStart, { once: true, passive: false });
    startOverlay.addEventListener('click', onStart, { once: true });

    container.addEventListener('click', () => {
        hidePrompt();
        if (current >= animateSections.length) return;

        // If revealing, just finish this section. Do NOT advance yet.
        if (finishCurrentSection()) return;

        // Not revealing? Start the next section now.
        revealSection(current);
        current++;
    });

    // === Keyboard: Esc -> hub; Enter -> start/advance (single handler) ===
    (() => {
        const hubHref = document.querySelector('.plea-hub-btn')?.href || '/pleas/';

        function keyHandler(e) {
            // don’t hijack typing
            const tag = (e.target?.tagName || '').toLowerCase();
            if (['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable) return;
            if (e.repeat) return;

            // ensure THIS is the only handler that runs for this event
            // (prevents double-fire from other capture/bubble listeners)
            const onceFlag = '__pleaHandled';
            if (e[onceFlag]) return;
            e[onceFlag] = true;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            if (e.key === 'Escape' || e.key === 'Esc') {
                window.location.assign(hubHref);
                return;
            }

            if (e.key === 'Enter') {
                if (!started) { onStart(e); return; }

                hidePrompt();
                if (current >= animateSections.length) return;

                if (finishCurrentSection()) return; // only finish if mid-reveal

                revealSection(current);             // otherwise start next
                current++;
            }
        }

        // attach ONCE at the very top of the tree, capture phase
        window.addEventListener('keydown', keyHandler, { capture: true });
    })();
});
