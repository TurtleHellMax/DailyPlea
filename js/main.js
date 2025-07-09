document.addEventListener('DOMContentLoaded', () => {
    const sections = document.querySelectorAll('.container .section');
    const animateSections = Array.from(sections).slice(1);
    const prompt = document.getElementById('continue-prompt');
    const container = document.querySelector('.container');
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const volumeNode = audioCtx.createGain();
    volumeNode.gain.setValueAtTime(0.5, audioCtx.currentTime);

    let clickBuffer = null;
    fetch('sounds/Voice1Hum.wav')
        .then(res => {
            if (!res.ok) throw new Error(`Audio fetch failed: ${res.status}`);
            return res.arrayBuffer();
        })
        .then(data => audioCtx.decodeAudioData(data))
        .then(buf => { clickBuffer = buf; })
        .catch(err => console.error(err));

    function playClick() {
        if (!clickBuffer) return;
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().then(playClick);
            return;
        }
        const src = audioCtx.createBufferSource();
        src.buffer = clickBuffer;
        src.connect(volumeNode);
        volumeNode.connect(audioCtx.destination);

        src.start();
    }

    // wrap only non-space chars
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
        promptTimer = setTimeout(() => {
            prompt.classList.add('visible');
        }, delay);
    };

    const revealSection = idx => {
        revealing = true;
        const chars = animateSections[idx].querySelectorAll('.char');
        const BASE_SPEED = 30;    // ms per character
        const PERIOD_PAUSE = 300;   // extra ms after a '.'
        let accDelay = 0;

        // clear any old timeouts
        timeouts.forEach(clearTimeout);
        timeouts = [];

        chars.forEach(c => {
            const id = setTimeout(() => {
                c.classList.add('visible');

                // 2) play the click on each character
                playClick();

                // scroll logic (keep 20% gutter)
                const charBottomOffset = c.offsetTop + c.clientHeight;
                const gutter = container.clientHeight * 0.2;
                if (charBottomOffset > container.scrollTop + container.clientHeight - gutter) {
                    const target = charBottomOffset - (container.clientHeight - gutter);
                    container.scrollTo({ top: target, behavior: 'smooth' });
                }

                // end-of-section
                if (c === chars[chars.length - 1]) {
                    revealing = false;
                    if (idx < animateSections.length - 2) schedulePrompt(idx);
                }
            }, accDelay);

            timeouts.push(id);
            accDelay += BASE_SPEED;
            if (c.textContent === '.') accDelay += PERIOD_PAUSE;
        });
    };

    // auto-start first reveal
    if (animateSections.length) {
        revealSection(0);
        current = 1;
    }

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
