(() => {
    const { $, state, MAX_BYTES } = window.MessagesApp;
    const { errMsg } = window.MessagesApp.utils;

    // One shared AudioContext
    const AC = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AC();

    class BufferPlayer {
        constructor(url, { onTick, onReady, onEnded } = {}) {
            this.url = url;
            this.onTick = onTick || (() => { });
            this.onReady = onReady || (() => { });
            this.onEnded = onEnded || (() => { });
            this.buffer = null; this.src = null;
            this.gain = audioCtx.createGain(); this.gain.connect(audioCtx.destination);
            this.offset = 0; this.startedAt = 0; this._raf = null; this._playing = false;
        }
        get duration() { return this.buffer ? this.buffer.duration : 0; }
        get currentTime() { return this._playing ? this.offset + (audioCtx.currentTime - this.startedAt) : this.offset; }
        async load() { const res = await fetch(this.url, { credentials: 'include' }); const ab = await res.arrayBuffer(); this.buffer = await audioCtx.decodeAudioData(ab.slice(0)); this.onReady(this.duration); }
        _tick = () => { this.onTick(this.currentTime, this.duration); if (this._playing) this._raf = requestAnimationFrame(this._tick); };
        _stopSource() { if (this.src) { try { this.src.onended = null; this.src.stop(); } catch { } this.src.disconnect(); this.src = null; } if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } this._playing = false; }
        _spawn(startAtSec) { const node = audioCtx.createBufferSource(); node.buffer = this.buffer; node.connect(this.gain); node.onended = () => { this._stopSource(); this.offset = Math.min(this.duration, startAtSec + (audioCtx.currentTime - this.startedAt)); if (this.offset >= this.duration - 1e-3) this.onEnded(); }; return node; }
        play() {
            if (!this.buffer) return; if (audioCtx.state === 'suspended') audioCtx.resume(); if (this._playing) return;
            this.offset = Math.max(0, Math.min(this.offset, Math.max(0, (this.duration || 0) - 1e-6)));
            this.src = this._spawn(this.offset); this.startedAt = audioCtx.currentTime; this.src.start(0, this.offset); this._playing = true; this._tick();
        }
        pause() { if (!this._playing) return; this.offset = this.currentTime; this._stopSource(); }
        seekTo(sec) { if (!this.buffer) return; const clamped = Math.max(0, Math.min(sec, this.duration || 0)); const was = this._playing; this.pause(); this.offset = clamped; if (was) this.play(); else this.onTick(this.currentTime, this.duration); }
        seekRatio(r) { this.seekTo((this.duration || 0) * Math.min(1, Math.max(0, r))); }
        setVolume(v01) { this.gain.gain.value = Math.min(1, Math.max(0, v01)); }
    }

    function msToClock(ms) { ms = Math.max(0, ms | 0); const s = (ms / 1000) | 0; const m = (s / 60) | 0; const r = s % 60; return m + ':' + String(r).padStart(2, '0'); }

    function setPlayerTotal(attId, ms) {
        const p = state.audioPlayers.get(attId); if (!p) return;
        p.totalMs = ms | 0; if (p.totEl) p.totEl.textContent = msToClock(p.totalMs);
    }
    function unregisterPlayersIn(root) {
        root.querySelectorAll('.audp').forEach(el => { const id = +el.dataset.attId || 0; if (id) state.audioPlayers.delete(id); });
    }

    function fallbackHTMLAudio(attId, root, btn, track, fill, curEl, totEl) {
        const tag = root.querySelector('.aud-src'); if (!tag) return;
        tag.addEventListener('loadedmetadata', () => { if (totEl && Number.isFinite(tag.duration)) totEl.textContent = msToClock(tag.duration * 1000); });
        btn.addEventListener('click', () => { if (tag.paused) { tag.play(); btn.textContent = '⏸'; } else { tag.pause(); btn.textContent = '▶'; } });
        tag.addEventListener('timeupdate', () => { if (Number.isFinite(tag.duration) && tag.duration > 0) { fill.style.width = `${(tag.currentTime / tag.duration) * 100}%`; if (curEl) curEl.textContent = msToClock(tag.currentTime * 1000); } });
        tag.addEventListener('ended', () => { btn.textContent = '▶'; fill.style.width = '0%'; });
        const p = state.audioPlayers.get(attId) || {}; p.tag = tag; state.audioPlayers.set(attId, p);
    }

    async function initAudioPlayer(attId, url, root) {
        const btn = root.querySelector('.audp-btn');
        const track = root.querySelector('.audp-track');
        const fill = root.querySelector('.audp-fill');
        const curEl = root.querySelector('.cur');
        const totEl = root.querySelector('.tot');

        const player = new BufferPlayer(url, {
            onTick: (t, d) => { if (d > 0) fill.style.width = `${(t / d) * 100}%`; if (curEl) curEl.textContent = msToClock(t * 1000); },
            onReady: (d) => { if (totEl) totEl.textContent = msToClock(d * 1000); },
            onEnded: () => { btn.textContent = '▶'; fill.style.width = '0%'; }
        });

        state.audioPlayers.set(attId, { root, btn, track, fill, curEl, totEl, player, totalMs: 0 });

        try { await player.load(); }
        catch { return fallbackHTMLAudio(attId, root, btn, track, fill, curEl, totEl); }

        btn.addEventListener('click', () => { if (btn.textContent === '▶') { player.play(); btn.textContent = '⏸'; } else { player.pause(); btn.textContent = '▶'; } });

        const clamp01 = x => Math.min(1, Math.max(0, x));
        const ratioFromX = (x) => { const r = track.getBoundingClientRect(); return clamp01((x - r.left) / r.width); };

        let dragging = false;
        track.addEventListener('pointerdown', e => { dragging = true; track.setPointerCapture?.(e.pointerId); player.seekRatio(ratioFromX(e.clientX)); });
        track.addEventListener('pointermove', e => { if (!dragging) return; player.seekRatio(ratioFromX(e.clientX)); });
        const end = e => { dragging = false; try { track.releasePointerCapture(e.pointerId); } catch { } };
        track.addEventListener('pointerup', end);
        track.addEventListener('pointercancel', end);
    }

    // ---- Recording (uses chips UI from attachments module) ----
    const canonicalAudioMime = (mt) => (mt || '').split(';')[0] || 'audio/webm';
    function pickAudioMimeType() {
        const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        if (!('MediaRecorder' in window)) return '';
        for (const t of cands) { try { if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(t)) return t; } catch { } }
        return '';
    }
    const extForMime = (mt) => (mt || '').includes('ogg') ? 'ogg' : ((mt || '').includes('mp4') ? 'm4a' : 'webm');

    async function probeAudioBlobMs(blob) {
        return new Promise((resolve) => {
            try {
                const a = document.createElement('audio'); a.preload = 'metadata';
                const url = URL.createObjectURL(blob); a.src = url;
                const fin = ms => { try { URL.revokeObjectURL(url); } catch { } resolve(ms | 0); };
                a.onloadedmetadata = () => fin(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0);
                a.onerror = () => fin(0);
            } catch { resolve(0); }
        });
    }

    async function startRecording() {
        if (state.recording.active) return;
        const recWarn = $('rec-warn');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mime = pickAudioMimeType();
            const opts = mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : {};
            const rec = new MediaRecorder(stream, opts);
            state.recording = { active: true, chunks: [], size: 0, rec, warnShown: false, mime };

            window.MessagesApp.syncSendUI?.();

            rec.ondataavailable = (e) => {
                const sz = e?.data?.size || 0; if (!sz) return;
                state.recording.chunks.push(e.data); state.recording.size += sz;
                if (!state.recording.warnShown && state.recording.size > 850 * 1024) { recWarn.style.display = ''; recWarn.textContent = 'Approaching 1MB limit…'; state.recording.warnShown = true; }
                if (state.recording.size > 990 * 1024) { stopRecording(true); }
            };
            rec.onstop = async () => {
                try { recWarn.style.display = 'none'; } catch { }
                try {
                    const mt = canonicalAudioMime(state.recording.mime || 'audio/webm');
                    const blob = new Blob(state.recording.chunks, { type: mt });
                    if (!blob.size) return;
                    const estMs = await probeAudioBlobMs(blob);
                    const ab = await blob.arrayBuffer();
                    const buf = new Uint8Array(ab);
                    if (buf.length > MAX_BYTES) { alert('Voice message too large'); return; }
                    const name = `voice.${extForMime(mt)}`;
                    window.MessagesApp.addPendingFile?.({ name, type: mt, buf, size: buf.length, encoding: null, durationMs: estMs });
                } catch (e) { alert(errMsg(e)); }
                finally {
                    try { stream.getTracks().forEach(t => t.stop()); } catch { }
                    state.recording = { active: false, chunks: [], size: 0, rec: null, warnShown: false, mime: state.recording.mime };
                    window.MessagesApp.syncSendUI?.();
                    try { $('btn-voice').textContent = 'Hold to record'; } catch { }
                }
            };

            rec.start(200);
        } catch (err) { alert('Could not start recording: ' + (err.message || err)); }
    }

    function stopRecording(force = false) {
        const rec = state.recording.rec;
        if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) { } }
        state.recording.active = false;
        if (force) { const el = $('rec-warn'); if (el) el.textContent = 'Stopped to keep under 1MB.'; }
    }

    // expose
    Object.assign(window.MessagesApp, {
        audio: {
            BufferPlayer, initAudioPlayer, fallbackHTMLAudio, setPlayerTotal, unregisterPlayersIn,
            msToClock, startRecording, stopRecording, canonicalAudioMime, pickAudioMimeType, extForMime, probeAudioBlobMs
        }
    });
})();
