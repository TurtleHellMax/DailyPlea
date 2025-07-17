document.addEventListener('DOMContentLoaded', () => {
    const sections = document.querySelectorAll('.container .section');
    const animateSections = Array.from(sections).slice(1);
    const prompt = document.getElementById('continue-prompt');
    const container = document.querySelector('.container');
    container.scrollTo({ top: 0, behavior: 'auto' });

    const startOverlay = document.getElementById('start-overlay');
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
    const CLICK_THROTTLE = 50;

    fetch('sounds/Voice2Hum.wav')
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status} for audio`);
            return r.arrayBuffer();
        })
        .then(data => audioCtx.decodeAudioData(data))
        .then(buf => { clickBuffer = buf; })
        .catch(err => console.error('Audio load failed:', err));

    requestAnimationFrame(() => {
        startText.classList.add('visible');
    });

    function playClick() {
        if (!clickBuffer || !resumed) return;
        const now = performance.now();
        if (now - lastClickTime < CLICK_THROTTLE) {
            return;
        }
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
        prompt.classList.remove('visible');
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
                    revealing = false;
                    if (idx < animateSections.length - 2) schedulePrompt(idx);
                    else if (idx === animateSections.length - 2) {
                        // <-- this was the *final* section
                        gtag('event', 'all_text_revealed', {
                            event_category: 'engagement',
                            event_label: 'full_text'
                        });

                        fetch('https://text-reveal-worker.dupeaccmax.workers.dev/', {
                            method: 'POST',
                            mode: 'cors'
                        })
                            .then(r => r.json())
                            .then(data => console.log('Beacon transmitted', data.count, 'times'))
                            .catch(console.error);
                    }
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

    startOverlay.addEventListener('pointerdown', onStart, { once: true });
    startOverlay.addEventListener('touchstart', onStart, { once: true, passive: false });
    startOverlay.addEventListener('click', onStart, { once: true });

    container.addEventListener('click', () => {
        hidePrompt();
        if (current >= animateSections.length) return;

        if (revealing) {
            timeouts.forEach(clearTimeout);
            animateSections[current - 1]
                .querySelectorAll('.char')
                .forEach(c => c.classList.add('visible'));
            revealing = false;
        }

        revealSection(current);
        current++;
    });
});
