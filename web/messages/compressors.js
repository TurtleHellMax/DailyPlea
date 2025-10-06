/*! compressors.js — rewritten to match requested behavior exactly
   - Exposes global `Compressors` AND a drop-in alias `compressFileSmart`.
   - Depends on: /web/vendor/ffmpeg/umd/ffmpeg.js (UMD build that defines window.FFmpeg or window.FFmpegWASM.FFmpeg)
*/
(function (global) {
    'use strict';

    // ---- constants & small utils ----
    const MAX_BYTES = 1024 * 1024; // 1 MB
    const HW_THREADS = Math.max(1, Math.min(8, (navigator.hardwareConcurrency | 0) || 2));

    const CORE_BASE_ST = '/web/vendor/ffmpeg/core';     // single-thread
    const CORE_BASE_MT = '/web/vendor/ffmpeg/core-mt';  // pthreads + SIMD

    const API = global.API_BASE || ''; // used by renderAttachmentInline; set in your app

    function dbg() { /* console.log('[compress]', ...arguments); */ }
    function dberr() { /* console.error('[compress]', ...arguments); */ }

    function wrapProgress(onProgress, label) {
        let last = -1;
        return (p, phase) => {
            const pct = Math.max(0, Math.min(1, +p || 0));
            if (pct - last >= 0.01 || pct === 1) {
                try { onProgress && onProgress(pct, phase || label); } catch (e) { }
                last = pct;
            }
        };
    }

    function concatU8(chunks, totalLen) {
        const out = new Uint8Array(totalLen);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
    }

    function fileNameOf(file, fallback = 'attachment') {
        return (file && typeof file.name === 'string' && file.name.trim()) ? file.name : fallback;
    }

    async function fetchFile(input, onProgress) {
        if (input instanceof Blob) {
            const total = input.size || 1;
            const CHUNK = 2 * 1024 * 1024;
            const parts = [];
            let off = 0, last = 0;
            while (off < total) {
                const end = Math.min(off + CHUNK, total);
                const ab = await input.slice(off, end).arrayBuffer();
                parts.push(new Uint8Array(ab));
                off = end;
                const p = Math.min(0.25, off / total * 0.25);
                if (p - last >= 0.01 || off === total) { onProgress && onProgress(p, 'loading input'); last = p; }
            }
            return concatU8(parts, parts.reduce((n, u) => n + u.length, 0));
        }
        const res = await fetch(input);
        const buf = new Uint8Array(await res.arrayBuffer());
        onProgress && onProgress(0.25, 'loading input');
        return buf;
    }

    function isPreviewableMime(mt = '') {
        mt = (mt || '').toLowerCase();
        return mt.startsWith('text/')
            || mt.includes('javascript')
            || mt.includes('json')
            || mt.includes('xml')
            || mt.includes('csv')
            || mt === 'application/pdf';
    }

    function extOf(name = '') { const m = name.match(/\.([^.]+)$/); return m ? m[1].toLowerCase() : ''; }
    function baseMime(mt = '') { return (mt || '').split(';')[0].trim().toLowerCase(); }
    function isTextLike(name, mt) {
        const e = extOf(name);
        if ((mt || '').startsWith('text/')) return true;
        const codeish = ['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'yml', 'yaml', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'c', 'cc', 'cpp', 'h', 'hpp', 'go', 'rs', 'py', 'rb', 'php', 'java', 'kt', 'swift', 'sql', 'sh', 'bat', 'ps1'];
        return codeish.includes(e);
    }
    function esc(s) { return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
    function niceBytes(n) { const u = ['B', 'KB', 'MB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${Math.round(n)} ${u[i]}`; }
    function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

    // ---- FFmpeg loader (UMD) ----
    let __ff = null;
    let __ffLoaded = false;
    let __ffProgressCb = null;

    async function getFFmpeg() {
        if (__ffLoaded) return __ff;

        const FFmpegCtor = window.FFmpegWASM?.FFmpeg || window.FFmpeg?.FFmpeg || window.FFmpeg;
        if (!FFmpegCtor) throw new Error('FFmpeg UMD not found. Expected window.FFmpegWASM.FFmpeg (v0.12+).');

        __ff = new FFmpegCtor();

        // Prefer MT core only when threads are actually usable
        const wantMT = self.crossOriginIsolated === true;

        const base = wantMT ? CORE_BASE_MT : CORE_BASE_ST;

        __ff.on('progress', ({ progress }) => {
            try {
                const p = Math.max(0, Math.min(0.97, progress || 0));
                __ffProgressCb && __ffProgressCb(p, 'transcoding');
            } catch { }
        });
        __ff.on('log', ({ message }) => console.debug('[ffmpeg]', message));

        await __ff.load({
            coreURL: `${base}/ffmpeg-core.js`,
            wasmURL: `${base}/ffmpeg-core.wasm`,
            workerURL: `${base}/ffmpeg-core.worker.js`,
        });

        __ffLoaded = true;
        return __ff;
    }

    // ---- Image helpers (incl. TIFF path) ----
    const MAX_LONG_SIDE_8K = 8192;

    async function getBitmapDims(file) {
        try {
            const bmp = await createImageBitmap(file);
            const dims = { w: bmp.width || 0, h: bmp.height || 0 };
            try { bmp.close && bmp.close(); } catch { }
            return dims;
        } catch {
            return { w: 0, h: 0 };
        }
    }

    async function downscaleIfOver8K(file, onProgress) {
        const name = (file?.name || '').trim() || 'image';
        const mt = (file?.type || '').toLowerCase();
        const isTiff = /image\/(tif|tiff)/i.test(mt) || /\.(tif|tiff)$/i.test(name);
        if (isTiff) return file; // keep TIFF for the special path

        const { w, h } = await getBitmapDims(file);
        const maxSide = Math.max(w, h);
        if (!w || !h || maxSide <= MAX_LONG_SIDE_8K) return file;

        const scale = MAX_LONG_SIDE_8K / maxSide;
        const W = Math.max(1, Math.round(w * scale));
        const H = Math.max(1, Math.round(h * scale));
        onProgress && onProgress(0.03, `pre-resize to ≤8K (${W}×${H})`);

        const canvas = ('OffscreenCanvas' in global)
            ? new OffscreenCanvas(W, H)
            : Object.assign(document.createElement('canvas'), { width: W, height: H });
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const bmp = await createImageBitmap(file);
        ctx.drawImage(bmp, 0, 0, W, H);
        try { bmp.close && bmp.close(); } catch { }

        const blob = canvas.convertToBlob
            ? await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
            : await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
        const outName = /\.[a-z0-9]+$/i.test(name) ? name.replace(/\.[a-z0-9]+$/i, '.jpg') : (name + '.jpg');
        return new File([blob], outName, { type: 'image/jpeg' });
    }

    async function tiffViaCanvasIfPossible(file, onProgress) {
        try {
            onProgress && onProgress(0.04, 'native TIFF decode');
            const bmp = await createImageBitmap(file); // throws if unsupported
            const w0 = bmp.width, h0 = bmp.height;
            if (!w0 || !h0) throw new Error('empty-bitmap');

            const MAX_LONG_START = 8192;
            const MIN_LONG = 480;
            const SCALE_STEP = 0.86;
            const qSteps = [0.82, 0.7, 0.6, 0.5, 0.42, 0.35, 0.28, 0.22, 0.18];

            const firstScale = Math.min(1, MAX_LONG_START / Math.max(w0, h0));
            let W = Math.max(1, Math.round(w0 * firstScale));
            let H = Math.max(1, Math.round(h0 * firstScale));

            const stage = ('OffscreenCanvas' in global)
                ? new OffscreenCanvas(W, H)
                : Object.assign(document.createElement('canvas'), { width: W, height: H });
            const sctx = stage.getContext('2d');
            sctx.imageSmoothingEnabled = true;
            sctx.imageSmoothingQuality = 'high';
            sctx.drawImage(bmp, 0, 0, W, H);
            try { bmp.close && bmp.close(); } catch { }

            async function encodeAtQ(cvs, q) {
                if (cvs.convertToBlob) return cvs.convertToBlob({ type: 'image/jpeg', quality: q });
                return new Promise(res => cvs.toBlob(res, 'image/jpeg', q));
            }

            let work = stage;
            let longSide = Math.max(W, H);
            while (true) {
                onProgress && onProgress(0.35, `encoding ${work.width}×${work.height}`);
                for (const q of qSteps) {
                    let blob = await encodeAtQ(work, q);
                    if (!blob) continue;
                    if (blob.size <= MAX_BYTES) {
                        onProgress && onProgress(0.98, 'finalizing');
                        return new Uint8Array(await blob.arrayBuffer());
                    }
                }
                if (longSide <= MIN_LONG) break;
                longSide = Math.max(MIN_LONG, Math.floor(longSide * SCALE_STEP));
                const scale = longSide / Math.max(work.width, work.height);
                const w = Math.max(1, Math.round(work.width * scale));
                const h = Math.max(1, Math.round(work.height * scale));
                const smaller = ('OffscreenCanvas' in global)
                    ? new OffscreenCanvas(w, h)
                    : Object.assign(document.createElement('canvas'), { width: w, height: h });
                const ctx = smaller.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(work, 0, 0, w, h);
                work = smaller;
            }

            throw new Error('still-over-1mb');
        } catch {
            return null;
        }
    }

    // ===== UTIF.js loader + BigTIFF detector =====
    let __utifLoaded = null; // will hold the UTIF namespace once loaded
    async function ensureUTIFLoaded() {
        if (__utifLoaded) return __utifLoaded;
        await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/utif@3.0.0/UTIF.min.js';
            s.crossOrigin = 'anonymous';
            s.referrerPolicy = 'no-referrer';
            s.onload = res;
            s.onerror = () => rej(new Error('UTIF loader failed'));
            document.head.appendChild(s);
        });
        // Some bundles expose UTIF under .default — normalize it
        const g = window.UTIF || (window.UTIF && window.UTIF.default) || window.UTIF?.default;
        if (!g || (!g.decode && !g.decodeImage)) {
            throw new Error('UTIF loaded but API not found');
        }
        __utifLoaded = g;
        return __utifLoaded;
    }

    // Quick signature check: returns 'big', 'classic', or 'unknown'
    async function sniffTiffKind(file) {
        try {
            const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
            const le = (head[0] === 0x49 && head[1] === 0x49); // 'II'
            const be = (head[0] === 0x4D && head[1] === 0x4D); // 'MM'
            if (!le && !be) return 'unknown';
            const tag = (le ? head[2] : head[3]);
            if (tag === 0x2B) return 'big';
            if (tag === 0x2A) return 'classic';
            return 'unknown';
        } catch { return 'unknown'; }
    }

    async function decodeTiffWithUTIFToJpegUnder1MB(file, onProgress) {
        const UTIF = await ensureUTIFLoaded();
        onProgress?.(0.32, 'UTIF: reading TIFF');

        const ab = await file.arrayBuffer();
        const ifds = UTIF.decode(ab);
        if (!ifds || !ifds.length) throw new Error('UTIF: no IFDs');

        if (typeof UTIF.decodeImages === 'function') {
            UTIF.decodeImages(ab, ifds);           // v2
        } else if (typeof UTIF.decodeImage === 'function') {
            for (const ifd of ifds) UTIF.decodeImage(ab, ifd); // v3
        } else {
            throw new Error('UTIF: no decodeImage(s) API');
        }

        const page = ifds[0];
        const W0 = page.width || page.t256 || page.ImageWidth || 0;
        const H0 = page.height || page.t257 || page.ImageLength || 0;
        if (!W0 || !H0) throw new Error('UTIF: unknown image dimensions');

        const rgba = UTIF.toRGBA8(page);

        // Paint decoded RGBA to a staging canvas
        const stage = ('OffscreenCanvas' in window)
            ? new OffscreenCanvas(W0, H0)
            : Object.assign(document.createElement('canvas'), { width: W0, height: H0 });
        const sctx = stage.getContext('2d');
        sctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), W0, H0), 0, 0);

        // Start with ≤8192 long edge for safety, then allow further downsizing if needed
        const MAX_LONG_START = 8192;
        const MIN_LONG = 480;   // how small we’re willing to go (tune as you like)
        const SCALE_STEP = 0.86;  // shrink 14% each time if still >1MB
        const qSteps = [0.82, 0.7, 0.6, 0.5, 0.42, 0.35, 0.28, 0.22, 0.18];

        // prepare first working canvas at ≤8192 long edge
        const firstScale = Math.min(1, MAX_LONG_START / Math.max(W0, H0));
        let W = Math.max(1, Math.round(W0 * firstScale));
        let H = Math.max(1, Math.round(H0 * firstScale));

        const makeCanvas = (w, h) => ('OffscreenCanvas' in window)
            ? new OffscreenCanvas(w, h)
            : Object.assign(document.createElement('canvas'), { width: w, height: h });

        let work = makeCanvas(W, H);
        {
            const ctx = work.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(stage, 0, 0, W, H);
        }

        async function encodeAtQ(cvs, q) {
            if (cvs.convertToBlob) return cvs.convertToBlob({ type: 'image/jpeg', quality: q });
            return new Promise(res => cvs.toBlob(res, 'image/jpeg', q));
        }

        let longSide = Math.max(W, H);
        while (true) {
            onProgress?.(0.9, `UTIF: encoding ${work.width}×${work.height}`);
            // try a quality ladder first
            for (const q of qSteps) {
                let blob = await encodeAtQ(work, q);
                if (!blob) continue;
                if (blob.size <= 1024 * 1024) {
                    onProgress?.(0.98, 'finalizing');
                    return new Uint8Array(await blob.arrayBuffer());
                }
            }
            // still too big → downscale and try again
            if (longSide <= MIN_LONG) break;
            longSide = Math.max(MIN_LONG, Math.floor(longSide * SCALE_STEP));
            const scale = longSide / Math.max(work.width, work.height);
            const w = Math.max(1, Math.round(work.width * scale));
            const h = Math.max(1, Math.round(work.height * scale));

            const smaller = makeCanvas(w, h);
            const ctx = smaller.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(work, 0, 0, w, h);
            work = smaller;
        }

        throw new Error('UTIF: still over 1MB');
    }

    // === TIFF/unsupported/huge images → try native → (BigTIFF/huge) UTIF → FFmpeg → UTIF fallback ===
    async function transcodeTiffToJpegUnder1MB(file, onProgress) {
        // 0) Try native decode first (fast path if the browser can decode)
        const nativeU8 = await tiffViaCanvasIfPossible(file, onProgress);
        if (nativeU8) return nativeU8;

        // 0.5) If it's BigTIFF or very large, prefer UTIF first (FFmpeg wasm often can’t parse headers)
        const kind = await sniffTiffKind(file);
        if (kind === 'big' || (file.size || 0) > 100 * 1024 * 1024) {
            try {
                return await decodeTiffWithUTIFToJpegUnder1MB(file, onProgress);
            } catch { /* fall through to ffmpeg path */ }
        }

        const ff = await getFFmpeg();
        const name = fileNameOf(file);

        // Guard truly massive inputs (prevents “stuck at 30%” feel)
        const TOO_LARGE_BYTES = 200 * 1024 * 1024; // 200MB
        if ((file.size || 0) > TOO_LARGE_BYTES) {
            // For very large TIFFs, UTIF is usually more reliable in-browser
            try {
                return await decodeTiffWithUTIFToJpegUnder1MB(file, onProgress);
            } catch {
                throw new Error(
                    `This TIFF is ${(file.size / 1048576 | 0)} MB — browser-side decoding is likely to stall. ` +
                    `Please export as JPEG/PNG (or a smaller TIFF) and try again.`
                );
            }
        }

        const inExt = (name.split('.').pop() || 'tiff').toLowerCase();
        const inName = `in.${inExt}`;
        const outName = 'out.jpg';

        const data = await fetchFile(file, (p, phase) => {
            onProgress?.(Math.min(0.25, p), phase || 'reading TIFF');
        });
        await ff.writeFile(inName, data);
        onProgress?.(0.28, 'writing to ffmpeg fs');

        let side = 1600; // clamp longest side early to cap memory
        let q = 8;       // ffmpeg JPEG q: 2(best)..31(worst)
        let pass = 0;
        let out;

        while (pass < 5) {
            pass += 1;
            try { await ff.deleteFile(outName); } catch { }

            __ffProgressCb = (p) => {
                const ui = 0.30 + Math.max(0, Math.min(1, p)) * 0.65;
                onProgress?.(ui, `decoding & scaling (q=${q}, max=${side}px)`);
            };

            const vf = `scale='if(gt(iw,ih),min(${side},iw),-2)':'if(lte(iw,ih),min(${side},ih),-2)':force_original_aspect_ratio=decrease`;

            // Try autodetect first
            let args = [
                '-hide_banner', '-loglevel', 'warning', '-y',
                '-max_alloc', '134217728',
                '-probesize', '10M',
                '-analyzeduration', '200M',
                '-threads', String(HW_THREADS),
                '-filter_threads', String(Math.max(1, HW_THREADS - 1)),
                '-fs', String(MAX_BYTES),
                '-i', inName,
                '-frames:v', '1',
                '-vf', vf,
                '-sws_flags', 'fast_bilinear',
                '-pix_fmt', 'yuvj420p',
                '-q:v', String(q),
                '-f', 'mjpeg',
                outName
            ];

            try {
                await ff.exec(args);
            } catch (err) {
                const msg = String(err?.message || err);
                // If the demuxer couldn’t find a stream/dimensions, try a stricter image2 single-image path
                if (/Unknown input format|could not find codec|Invalid data|unspecified size|does not contain any stream/i.test(msg)) {
                    args = [
                        '-hide_banner', '-loglevel', 'warning', '-y',
                        '-max_alloc', '134217728',
                        '-probesize', '20M',
                        '-analyzeduration', '400M',
                        '-threads', String(HW_THREADS),
                        '-filter_threads', String(Math.max(1, HW_THREADS - 1)),
                        '-fs', String(MAX_BYTES),
                        '-f', 'image2', '-pattern_type', 'none',
                        '-i', inName,
                        '-frames:v', '1',
                        '-vf', vf,
                        '-sws_flags', 'fast_bilinear',
                        '-pix_fmt', 'yuvj420p',
                        '-q:v', String(q),
                        '-f', 'mjpeg',
                        outName
                    ];
                    try {
                        await ff.exec(args);
                    } catch {
                        // Fall back to UTIF.js if FFmpeg still can’t see the image stream
                        try {
                            const u8 = await decodeTiffWithUTIFToJpegUnder1MB(file, onProgress);
                            return u8;
                        } catch {
                            throw new Error('Failed to produce a JPEG from this TIFF. ffmpeg could not find a valid image stream, and UTIF.js fallback also failed. This file may require full desktop tools.');
                        }
                    }
                } else if (/index out of bounds|Aborted\(\)/i.test(msg)) {
                    // wasm OOM → UTIF fallback
                    try {
                        const u8 = await decodeTiffWithUTIFToJpegUnder1MB(file, onProgress);
                        return u8;
                    } catch {
                        throw new Error(
                            'FFmpeg ran out of memory or could not parse this TIFF in the browser. ' +
                            'Try exporting as JPEG/PNG (or a smaller TIFF) and re-upload.'
                        );
                    }
                } else {
                    throw err;
                }
            }

            // Try to read output
            try {
                out = await ff.readFile(outName);
            } catch {
                // If FFmpeg wrote nothing (no stream), use UTIF fallback
                const u8 = await decodeTiffWithUTIFToJpegUnder1MB(file, onProgress);
                return u8;
            }

            if (out.length <= 1024 * 1024) break;

            // tighten for next attempt
            if (q < 18) q += 3; else side = Math.max(640, Math.floor(side * 0.85));
        }

        onProgress?.(0.98, 'finalizing');

        if (!out || out.length > 1024 * 1024) {
            throw new Error('Could not reduce TIFF under 1 MB. Please export as JPEG/PNG and try again.');
        }
        return new Uint8Array(out);
    }

    // === Image compressor: canvas -> JPEG (fast & tiny dep) ===
    async function compressImageUnder1MB(file, onProgress) {
        const name = fileNameOf(file);
        const mt = (file.type || '').toLowerCase();
        const isTiff = /image\/(tif|tiff)/i.test(mt) || /\.(tif|tiff)$/i.test(name);
        const isHuge = (file.size || 0) > 25 * 1024 * 1024;

        // TIFF or super-huge → ffmpeg path
        if (isTiff || isHuge) {
            return transcodeTiffToJpegUnder1MB(file, onProgress);
        }

        // 8K guard first: for non-TIFF types
        try {
            const maybeDown = await downscaleIfOver8K(file, onProgress);
            if (maybeDown && maybeDown !== file) {
                file = maybeDown; // proceed with the pre-resized file
            }
        } catch { /* non-fatal — continue with original */ }

        onProgress?.(0.05, 'reading');  // ← keep your existing line after the guard

        // Some browsers throw here for odd inputs — catch and fallback
        let bmp;
        try {
            bmp = await createImageBitmap(file);
        } catch {
            return transcodeTiffToJpegUnder1MB(file, onProgress);
        }

        const maxSide = 1280;
        const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * s));
        const h = Math.max(1, Math.round(bmp.height * s));

        const canvas = ('OffscreenCanvas' in window)
            ? new OffscreenCanvas(w, h)
            : Object.assign(document.createElement('canvas'), { width: w, height: h });

        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0, w, h);
        onProgress?.(0.4, 'resizing');

        let q = 0.75;
        let blob;

        async function encode(qval) {
            if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality: qval });
            return new Promise(res => (canvas).toBlob(res, 'image/jpeg', qval));
        }

        blob = await encode(q);
        onProgress?.(0.6, 'encoding');

        while (blob.size > MAX_BYTES && q > 0.35) {
            q = Math.max(0.35, q - 0.1);
            blob = await encode(q);
        }

        if (blob.size > MAX_BYTES) throw new Error('Exceeds 1 MB even after downscaling.');
        onProgress?.(1, 'finalizing');
        return new Uint8Array(await blob.arrayBuffer());
    }

    // === Generic compressor: gzip (browser built-in) ===
    async function gzipGeneric(file, onProgress) {
        const t0 = performance.now();
        const prog = wrapProgress(onProgress, 'gzipGeneric');
        dbg('gzipGeneric.in', { name: file?.name || '(no name)', size: file?.size || 0, type: file?.type || '(none)' });

        prog(0.02, 'starting');

        // Fallback: no CompressionStream → passthrough (≤1MB only)
        if (!('CompressionStream' in window)) {
            dbg('gzipGeneric: CompressionStream unavailable — passthrough path');
            const raw = new Uint8Array(await file.arrayBuffer());
            if (raw.length > MAX_BYTES) throw new Error('File exceeds 1 MB and gzip is unavailable here.');
            const blob = new Blob([raw], { type: file.type || 'application/octet-stream' });
            prog(1, 'finalizing');
            dbg('gzipGeneric.out(passthrough)', await sniffBlob(blob), { dtMs: +(performance.now() - t0).toFixed(1) });
            return { blob, encoding: null };
        }

        // Stream: write input → read compressed output concurrently
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        const reader = cs.readable.getReader();

        const total = file.size || 1;
        const CHUNK = 256 * 1024; // 256KB
        let offset = 0, lastTick = 0;

        let outLen = 0;
        const outChunks = [];
        let exceeded = false;

        const consumePromise = (async () => {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value && value.length) {
                        outChunks.push(value);
                        outLen += value.length;
                        // EARLY EXIT: if compressed stream already exceeds cap, stop immediately
                        if (outLen > MAX_BYTES) {
                            exceeded = true;
                            try { await reader.cancel('size-limit'); } catch { }
                            break;
                        }
                    }
                }
            } catch (e) {
                dberr('gzipGeneric.consume error', e);
                throw e;
            }
        })();

        // Watchdog (unchanged)
        let lastMove = performance.now();
        const WD_MS = 5000;
        const wd = setInterval(() => {
            const now = performance.now();
            if (now - lastMove > WD_MS) {
                dbg('gzipGeneric.watchdog', { offset, total, pct: +(offset / total).toFixed(3) });
                lastMove = now;
            }
        }, WD_MS);

        try {
            while (offset < total) {
                const end = Math.min(offset + CHUNK, total);
                const ab = await file.slice(offset, end).arrayBuffer();
                await writer.write(new Uint8Array(ab));
                offset = end;

                // NEW: abort immediately if we’ve already exceeded budget
                if (exceeded || outLen > MAX_BYTES) {
                    try { await writer.abort('size-limit'); } catch { }
                    throw new Error('Exceeds 1 MB even after gzip (early abort).');
                }

                const p = Math.min(0.9, offset / total);
                if (p - lastTick >= 0.02 || offset === total) {
                    prog(p, 'compressing');
                    lastTick = p;
                    lastMove = performance.now();
                }
            }
        } catch (e) {
            dberr('gzipGeneric.loop error', e);
            throw e;
        } finally {
            clearInterval(wd);
            try { await writer.close(); } catch (e) { dberr('gzipGeneric.close writer error', e); }
        }

        await consumePromise;

        const gzU8 = concatU8(outChunks, outLen);
        if (gzU8.length > MAX_BYTES) throw new Error('Exceeds 1 MB even after gzip.');
        prog(1, 'finalizing');

        const outBlob = new Blob([gzU8], { type: file.type || 'application/octet-stream' });
        dbg('gzipGeneric.out', await sniffBlob(outBlob), {
            ratio: +(gzU8.length / (file.size || 1)).toFixed(3),
            dtMs: +(performance.now() - t0).toFixed(1)
        });

        return { blob: outBlob, encoding: 'gzip' };
    }

    // === AUDIO: FFmpeg -> WebM/Opus under 1 MB ===
    function planAudio(durationSec) {
        const dur = Math.max(0.5, Number.isFinite(durationSec) ? durationSec : 10);
        const budgetBits = (MAX_BYTES - 8 * 1024) * 8;
        const kbps = clamp(Math.floor(budgetBits / dur / 1000), 12, 64);
        return { kbps };
    }

    function probeDuration(file) {
        return new Promise((resolve) => {
            try {
                const el = document.createElement('video');
                el.preload = 'metadata';
                el.src = URL.createObjectURL(file);
                el.onloadedmetadata = () => {
                    const d = Number.isFinite(el.duration) ? el.duration : 0;
                    URL.revokeObjectURL(el.src);
                    resolve(d);
                };
                el.onerror = () => { try { URL.revokeObjectURL(el.src); } catch { } resolve(0); };
            } catch { resolve(0); }
        });
    }

    async function compressAudioUnder1MB(file, onProgress) {
        const ff = await getFFmpeg();
        const dur = await probeDuration(file) || 10;
        const { kbps } = planAudio(dur);

        const inName = 'in.' + (file.name.split('.').pop() || 'dat');
        const outName = 'out.webm';
        await ff.writeFile(inName, await fetchFile(file));

        __ffProgressCb = (p, phase) => onProgress?.(p, `encoding ${kbps}kbps`);
        await ff.exec([
            '-hide_banner', '-y',
            '-fs', String(MAX_BYTES),
            '-threads', String(HW_THREADS),
            '-i', inName,
            '-vn',
            '-ac', '1',
            '-ar', '48000',
            '-c:a', 'libopus',
            '-b:a', `${kbps}k`,
            outName
        ]);

        let out = await ff.readFile(outName);
        let tries = 0, cur = kbps;
        while (out.length > MAX_BYTES && tries < 3) {
            tries += 1; cur = Math.max(12, Math.floor(cur * 0.75));
            await ff.exec(['-y', '-fs', String(MAX_BYTES), '-i', inName, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', `${cur}k`, outName]);
            out = await ff.readFile(outName);
        }

        if (out.length > MAX_BYTES) throw new Error('Audio exceeds 1 MB even after multiple passes.');
        return new Blob([out], { type: 'audio/webm' });
    }

    // === Video helpers, probes and planning ===
    function probeVideoSize(file) {
        return new Promise((resolve) => {
            try {
                const el = document.createElement('video');
                el.preload = 'metadata';
                el.src = URL.createObjectURL(file);
                el.onloadedmetadata = () => {
                    const w = el.videoWidth || 0, h = el.videoHeight || 0;
                    URL.revokeObjectURL(el.src);
                    resolve({ w, h });
                };
                el.onerror = () => { try { URL.revokeObjectURL(el.src); } catch { } resolve({ w: 0, h: 0 }); };
            } catch { resolve({ w: 0, h: 0 }); }
        });
    }

    // === Compute a sensible plan to fit under maxBytes ===
    function planVideo({ durationSec, srcW, srcH }) {
        // If duration is unknown/very small, assume long content but clip to 6s.
        const durKnown = Number.isFinite(durationSec) && durationSec > 0;
        const cutSec = durKnown ? Math.min(durationSec, 6) : 6;

        // Reserve some container overhead
        const budgetBits = (MAX_BYTES - 20 * 1024) * 8;

        // average kbps allowed across that clip
        const totalKbps = Math.max(12, Math.floor(budgetBits / cutSec / 1000));

        // Start with NO audio to maximize chance of <1MB
        const aKbps = 0;
        const vKbps = Math.max(10, totalKbps - aKbps);

        const aspect = (srcW > 0 && srcH > 0) ? (srcW / srcH) : (16 / 9);
        const fps = cutSec >= 5 ? 8 : 10;

        // Very low bits-per-pixel target
        const targetBpp = 0.035;
        const wFloat = Math.sqrt((vKbps * 1000) / (targetBpp * fps * aspect));
        const snaps = [96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 272, 288, 320];
        let maxW = snaps.reduce((a, b) => Math.abs(b - wFloat) < Math.abs(a - wFloat) ? b : a, snaps[0]);
        maxW = Math.min(srcW || maxW, maxW);

        return { fps, vKbps, aKbps, maxW, cutSec };
    }

    async function probeBytesPerSecond(ff, inName, {
        width, fps, vkbps, akbps, sampleSec = 6, seekSec = 0
    }) {
        const outProbe = 'probe.webm';
        try { await ff.deleteFile(outProbe); } catch { }
        const vf = `scale=${width}:-2,fps=${fps}`;

        const args = [
            '-hide_banner', '-loglevel', 'warning', '-y',
            '-nostdin', '-sn', '-dn', '-analyzeduration', '4M', '-probesize', '256k',
            '-ss', String(Math.max(0, seekSec)), // sample a representative section
            '-t', String(sampleSec),
            '-threads', String(HW_THREADS),
            '-filter_threads', String(Math.max(1, HW_THREADS - 1)),
            '-i', inName,
            '-map', '0:v:0', '-map', '0:a:0?',
            '-vf', vf, '-pix_fmt', 'yuv420p',
            '-c:v', 'libvpx',
            '-b:v', `${vkbps}k`, '-maxrate', `${vkbps}k`, '-bufsize', `${Math.max(2 * vkbps, 32)}k`,
            '-quality', 'realtime', '-cpu-used', '8', '-lag-in-frames', '0', '-g', '90', '-deadline', 'realtime',
            '-c:a', 'libopus', '-b:a', `${akbps}k`, '-ac', '1', '-ar', '48000',
            outProbe
        ];

        await ff.exec(args);
        const u8 = await ff.readFile(outProbe);
        return u8.length / sampleSec; // bytes per second
    }

    async function multiProbeBps(ff, inName, opts) {
        const { totalSec = 0 } = opts || {};
        const spots = [];
        // probe an early and a mid segment to catch action-y sections
        spots.push(Math.max(0, Math.floor(totalSec * 0.10)));
        if (totalSec > 12) spots.push(Math.max(0, Math.floor((totalSec - 6) / 2)));
        let worst = 0;
        for (const ss of spots) {
            const bps = await probeBytesPerSecond(ff, inName, { ...opts, seekSec: ss || 0 });
            worst = Math.max(worst, bps);
        }
        return worst || await probeBytesPerSecond(ff, inName, opts);
    }

    // Extract a poster frame as a safe fallback (JPG under 1 MB)
    async function extractPosterFrame(ff, inName, outNameJpg = 'thumb.jpg', width = 256) {
        const vf = `scale=${width}:-2:flags=fast_bilinear`;
        for (const t of [60, 5, 120]) { // try a few safe offsets
            try { await ff.deleteFile(outNameJpg); } catch { }
            try {
                await ff.exec([
                    '-hide_banner', '-loglevel', 'warning', '-y', '-nostdin', '-sn', '-dn',
                    '-threads', String(HW_THREADS),
                    '-filter_threads', String(Math.max(1, HW_THREADS - 1)),
                    '-i', inName,
                    '-ss', String(t),
                    '-vframes', '1',
                    '-vf', vf,
                    '-qscale:v', '7',
                    outNameJpg
                ]);
                const jpg = await ff.readFile(outNameJpg).catch(() => null);
                if (jpg && jpg.length) return jpg;
            } catch { }
        }
        return null;
    }

    async function compressVideoUnder1MB_STRICT(file, onProgress) {
        const ff = await getFFmpeg();

        const logs = [];
        const logHandler = ({ message }) => { if (message) logs.push(String(message)); };
        ff.on?.('log', logHandler);
        const tail = () => logs.slice(-80).join('\n');

        try {
            const [dur, { w: srcW, h: srcH }] = await Promise.all([probeDuration(file), probeVideoSize(file)]);
            const totalSec = (Number.isFinite(dur) && dur > 0) ? dur : 10;

            // Always keep audio; we’ll only lower its bitrate (never drop it).
            let a = 20;                                    // audio kbps (min 6)
            const overheadBits = 24 * 1024 * 8;            // container allowance
            const budgetBits = Math.max(8 * 1024, (MAX_BYTES * 8) - overheadBits);
            let v = Math.max(8, Math.floor(budgetBits / totalSec / 1000) - a); // video kbps (min 6)

            // Initial width/fps from bitrate & aspect; loop will ratchet these down as needed.
            const aspect = (srcW > 0 && srcH > 0) ? (srcW / srcH) : (16 / 9);
            let fps = 12;
            const targetBpp = 0.035;
            const wFloat = Math.sqrt((v * 1000) / (targetBpp * fps * aspect));
            const snaps = [96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 272, 288, 320, 360, 384, 426];
            let width = Math.min(srcW || snaps.at(-1), snaps.reduce((a_, b) => Math.abs(b - wFloat) < Math.abs(a_ - wFloat) ? b : a_, snaps[0]));

            const inName = 'in.' + (file.name.split('.').pop() || 'dat');
            const outName = 'out.webm';
            await ff.writeFile(inName, await fetchFile(file));

            // Pick a representative probe window (middle of the video if long enough)
            let seekMid = 0;
            if (Number.isFinite(totalSec) && totalSec > 10) {
                seekMid = Math.floor((totalSec - 6) / 2);
            }
            // 1) run 6s probe at current guess
            const bps = await multiProbeBps(ff, inName, {
                width, fps, vkbps: v, akbps: a, sampleSec: 6, totalSec: totalSec, seekSec: seekMid
            });

            // 2) estimate full size and pre-adjust before the full encode loop
            const estBytes = bps * totalSec;
            // leave margin so we don't land just over 1MB
            const SAFE_MAX = Math.floor(MAX_BYTES * 0.85);

            if (estBytes > SAFE_MAX) {
                // Ratio we need to shrink by
                const shrink = SAFE_MAX / estBytes;

                // Prefer reducing video bitrate first (keeps duration+audio)
                v = Math.max(6, Math.floor(v * shrink));

                // If still aggressive shrink, also nudge resolution/fps
                if (shrink < 0.85) {
                    width = Math.max(96, Math.floor(width * Math.sqrt(shrink))); // bpp-ish scaling
                    fps = Math.max(5, Math.floor(fps * Math.max(0.80, shrink)));
                }
            } else if (estBytes < SAFE_MAX * 0.65) {
                // We have headroom → spend it for quality (still below cap)
                const grow = Math.min(1.35, SAFE_MAX / Math.max(estBytes, 1));
                v = Math.min(220, Math.ceil(v * Math.min(1.25, grow)));
                if (a === 20 && estBytes < SAFE_MAX * 0.5) a = 24; // small audio bump if very small
                width = Math.min(426, Math.ceil(width * Math.min(1.15, Math.sqrt(grow))));
                if (fps < 12) fps = Math.min(12, Math.ceil(fps * 1.1));
            }

            {
                const minV = 6, minA = 6, minW = 96, minF = 5;
                const worstMinBps = await multiProbeBps(ff, inName, {
                    width: minW, fps: minF, vkbps: minV, akbps: minA, sampleSec: 6, totalSec: totalSec
                });
                if (worstMinBps * totalSec > SAFE_MAX) {
                    // Full-length cannot fit under any sane settings—fail *before* long transcode.
                    throw new Error(`cannot_preserve_full_length_under_1mb (min settings estimate ${(worstMinBps * totalSec | 0)} bytes)`);
                }
            }

            let pass = 0, out;
            let triedNoAudio = false;

            while (pass < 14) {
                pass += 1;
                try { await ff.deleteFile(outName); } catch { }

                __ffProgressCb = (p) => onProgress?.(Math.min(0.98, p), `pass ${pass}: full length, ${width}w @${fps}fps, v${v}k / a${a}k`);

                const vf = `scale=${width}:-2,fps=${fps}`;
                const args = [
                    '-hide_banner', '-loglevel', 'warning', '-y',
                    '-nostdin', '-sn', '-dn', '-analyzeduration', '4M', '-probesize', '256k',
                    '-threads', String(HW_THREADS),
                    '-filter_threads', String(Math.max(1, HW_THREADS - 1)),
                    '-i', inName,
                    // Full duration (NO -t / -ss). Map primary video + optional primary audio.
                    '-map', '0:v:0', '-map', '0:a:0?',
                    // Video (VP8 = wasm-friendly)
                    '-vf', vf, '-pix_fmt', 'yuv420p',
                    '-c:v', 'libvpx', '-b:v', `${v}k`,
                    '-maxrate', `${v}k`, '-bufsize', `${Math.max(2 * v, 32)}k`,
                    '-quality', 'realtime', '-cpu-used', '8', '-lag-in-frames', '0', '-g', '90', '-deadline', 'realtime',
                    // Audio (keep if source has it)
                    '-c:a', 'libopus', '-b:a', `${a}k`, '-ac', '1', '-ar', '48000',
                    outName
                ];

                try {
                    await ff.exec(args);
                } catch (err) {
                    const msg = String(err?.message || err);
                    // If input has no audio, retry once without audio flags.
                    if (!triedNoAudio && /Stream specifier|matches no streams|cannot find a stream/i.test(msg)) {
                        triedNoAudio = true;
                        const argsNoAud = [
                            '-hide_banner', '-loglevel', 'warning', '-y',
                            '-nostdin', '-sn', '-dn', '-analyzeduration', '4M', '-probesize', '256k',
                            '-i', inName,
                            '-map', '0:v:0',
                            '-vf', vf, '-pix_fmt', 'yuv420p',
                            '-c:v', 'libvpx', '-b:v', `${v}k`, '-maxrate', `${v}k`, '-bufsize', `${Math.max(2 * v, 32)}k`,
                            '-quality', 'realtime', '-cpu-used', '8', '-lag-in-frames', '0', '-g', '90', '-deadline', 'realtime',
                            '-an',
                            outName
                        ];
                        await ff.exec(argsNoAud);
                    } else if (/index out of bounds|Aborted\(\)/i.test(msg)) {
                        // wasm OOM → make cheaper and retry
                        width = Math.max(96, Math.floor(width * 0.85));
                        fps = Math.max(5, Math.floor(fps * 0.90));
                        v = Math.max(6, Math.floor(v * 0.85));
                        a = Math.max(6, Math.floor(a * 0.90));
                        continue;
                    } else {
                        throw new Error(`${msg}\n--- ffmpeg tail ---\n${tail()}`);
                    }
                }

                out = await ff.readFile(outName);
                if (out.length <= MAX_BYTES) break;

                // Too big → reduce quality but keep length + audio
                v = Math.max(6, Math.floor(v * 0.75));
                a = Math.max(6, Math.floor(a * 0.85));
                width = Math.max(96, Math.floor(width * 0.90));
                fps = Math.max(5, Math.floor(fps * 0.92));
            }

            if (!out || out.length > MAX_BYTES) {
                throw new Error(`Could not fit under 1MB while preserving full length and audio.
Final attempt: ${width}w @${fps}fps, v${v}k/a${a}k.
--- ffmpeg tail ---
${tail()}`);
            }
            return new Blob([out], { type: 'video/webm' });
        } catch (e) {
            const msg = e?.message || String(e);
            throw new Error(msg.includes('ffmpeg tail') ? msg : `${msg}\n--- ffmpeg tail ---\n${tail()}`);
        } finally {
            __ffProgressCb = null;
            try { ff.off?.('log', logHandler); } catch { }
            try { await ff.deleteFile('out.webm'); } catch { }
            try { await ff.deleteFile('in.mov'); } catch { }
            try { await ff.deleteFile('in.mp4'); } catch { }
            try { await ff.deleteFile('in.dat'); } catch { }
        }
    }

    async function compressVideoUnder1MB(file, onProgress) {
        const ff = await getFFmpeg();

        // capture logs for useful tails
        const logs = [];
        const logHandler = ({ message }) => { if (message) logs.push(String(message)); };
        ff.on?.('log', logHandler);
        const tail = () => logs.slice(-80).join('\n');

        try {
            const [dur, { w: srcW, h: srcH }] = await Promise.all([probeDuration(file), probeVideoSize(file)]);
            const plan = planVideo({ durationSec: dur, srcW, srcH });
            let v = plan.vKbps, a = plan.aKbps, fps = plan.fps, width = plan.maxW;
            let cutSec = plan.cutSec;

            const inName = 'in.' + (file.name.split('.').pop() || 'dat');
            const outName = 'out.webm';
            await ff.writeFile(inName, await fetchFile(file));

            const SAFE_MAX = Math.floor(MAX_BYTES * 0.85); // 15% headroom to avoid “just over”
            // First probe with the current guess:
            let bps = await multiProbeBps(ff, inName, { width, fps, vkbps: v, akbps: a, sampleSec: 6, totalSec: dur || 0 });
            // Estimated bytes for chosen clip duration:
            let estBytes = bps * cutSec;
            // Ratchet *before* first full encode
            let guard = 0;
            while (estBytes > SAFE_MAX && guard++ < 6) {
                // Prefer bitrate first, then width, then fps, then cut length.
                v = Math.max(8, Math.floor(v * 0.80));
                width = Math.max(96, Math.floor(width * 0.90));
                if (guard >= 2) fps = Math.max(5, Math.floor(fps * 0.92));
                if (guard >= 3) cutSec = Math.max(2, Math.floor(cutSec * 0.9));
                bps = await multiProbeBps(ff, inName, { width, fps, vkbps: v, akbps: a, sampleSec: 6, totalSec: dur || 0 });
                estBytes = bps * cutSec;
            }
            // Absolute feasibility check at minimums — avoid futile encodes
            {
                const minV = 8, minW = 96, minF = 5, minT = 2, minA = 0;
                const worstMinBps = await multiProbeBps(ff, inName, { width: minW, fps: minF, vkbps: minV, akbps: minA, sampleSec: 4, totalSec: dur || 0 });
                if (worstMinBps * minT > SAFE_MAX) {
                    // Too dense even for 2s @ 96px wide → bail early (or poster frame)
                    const jpg = await extractPosterFrame(ff, inName, 'thumb.jpg', 256);
                    if (jpg) {
                        const blob = new Blob([jpg], { type: 'image/jpeg' });
                        throw new Error(`video_too_dense_for_1mb;poster_frame:${blob.size}`);
                    }
                    throw new Error('video_too_dense_for_1mb');
                }
            }

            let pass = 0, out;

            while (pass < 7) {
                pass += 1;
                try { await ff.deleteFile(outName); } catch { }

                __ffProgressCb = (p) =>
                    onProgress?.(Math.min(0.98, p), `pass ${pass}: ${width}w @${fps}fps, v${v}k ${a ? `/ a${a}k` : '/ no audio'} (${cutSec}s)`);

                // Scale + fps
                const vf = `scale=${width}:-2,fps=${fps}`;

                let seekSec = 0;
                if (Number.isFinite(dur) && dur > cutSec + 2) {
                    seekSec = Math.max(1, Math.floor((dur - cutSec) / 2));
                }

                // Build args. Start with no audio; we’ll only add tiny audio if we get well under the cap.
                const base = [
                    '-hide_banner', '-loglevel', 'warning', '-y',
                    // Input-side: avoid parsing PGS subs & heavy probing
                    '-nostdin', '-sn', '-dn', '-analyzeduration', '4M', '-probesize', '256k',
                    '-i', inName,
                    // Keep only primary video stream
                    '-map', '0:v:0',
                    // Clip to tiny excerpt
                    '-ss', String(seekSec), '-t', String(cutSec),
                    '-fs', String(MAX_BYTES),
                    // Video — VP8 is wasm-friendly & quick
                    '-vf', vf,
                    '-pix_fmt', 'yuv420p',
                    '-c:v', 'libvpx',
                    '-b:v', `${v}k`,
                    '-maxrate', `${v}k`,
                    '-bufsize', `${Math.max(2 * v, 32)}k`,
                    '-quality', 'realtime',
                    '-cpu-used', '8',
                    '-lag-in-frames', '0',
                    '-g', '60',
                    '-deadline', 'realtime'
                ];

                const withAudio = (a && a > 0) ? base.concat([
                    // tiny mono Opus (only if we’ve enabled audio)
                    '-c:a', 'libopus', '-b:a', `${a}k`, '-ac', '1', '-ar', '48000'
                ]) : base.concat(['-an']);

                const args = withAudio.concat([outName]);

                try {
                    await ff.exec(args);
                } catch (err) {
                    const msg = String(err?.message || err);
                    if (/index out of bounds|Aborted\(\)/i.test(msg)) {
                        // Make the job cheaper and try again
                        width = Math.max(96, Math.floor(width * 0.85));
                        fps = Math.max(5, Math.floor(fps * 0.9));
                        v = Math.max(8, Math.floor(v * 0.85));
                        // Also try even shorter clip if we’re still big
                        cutSec = Math.max(2, Math.floor(cutSec * 0.85));
                        continue;
                    }
                    throw new Error(`${msg}\n--- ffmpeg tail ---\n${tail()}`);
                }

                out = await ff.readFile(outName);
                const UNDER_TINY = 300 * 1024;   // 300 KB
                const UNDER_ROOM = 700 * 1024;   // 700 KB gives headroom for audio

                if (out && out.length < UNDER_TINY && cutSec < 12) {
                    // Make the clip longer first — most desirable improvement
                    cutSec = Math.min(12, Math.ceil(cutSec * 1.6)); // 6s -> ~10s
                    continue; // re-encode with longer t
                }

                if (out && out.length < UNDER_ROOM) {
                    // Spend more bits and pixels; optionally add tiny audio
                    v = Math.min(200, Math.ceil(v * 1.35));         // raise video bitrate
                    width = Math.min(426, Math.ceil(width * 1.15));  // bump width a bit
                    if (fps < 12) fps = Math.min(12, Math.ceil(fps * 1.1)); // small fps nudge
                    if (a === 0 && out.length > 200 * 1024) a = 24; // add mono Opus if we have space
                    continue; // try again with higher quality
                }

                if (out.length <= MAX_BYTES) break;

                // Tighten for next attempt:
                // 1) lower video bitrate, 2) smaller res/fps, 3) shorten clip, 4) (only if under budget) add minimal audio later
                v = Math.max(8, Math.floor(v * 0.72));
                width = Math.max(96, Math.floor(width * 0.88));
                if (pass >= 2) fps = Math.max(5, Math.floor(fps * 0.9));
                if (pass >= 3) cutSec = Math.max(2, Math.floor(cutSec * 0.85));
                // Still too large after 4 passes? keep audio disabled; only consider audio if we fall < 700KB later (not shown here).
            }

            if (!out || out.length > MAX_BYTES) {
                throw new Error(`Video still >1MB after reductions.\n--- ffmpeg tail ---\n${tail()}`);
            }
            return new Blob([out], { type: 'video/webm' });
        } catch (e) {
            const msg = e?.message || String(e);
            throw new Error(msg.includes('ffmpeg tail') ? msg : `${msg}\n--- ffmpeg tail ---\n${tail()}`);
        } finally {
            __ffProgressCb = null;
            try { ff.off?.('log', logHandler); } catch { }
            // best-effort cleanup
            try { await ff.deleteFile('out.webm'); } catch { }
            try { await ff.deleteFile('in.mov'); } catch { }
            try { await ff.deleteFile('in.mp4'); } catch { }
            try { await ff.deleteFile('in.dat'); } catch { }
        }
    }

    // === PUBLIC: route to correct compressor (used by your handleFileInput) ===
    function fixFilenameForType(origName, mime) {
        const base = origName && /\.[a-z0-9]+$/i.test(origName) ? origName.replace(/\.[a-z0-9]+$/i, '') : (origName || 'attachment');
        const m = (mime || '').toLowerCase();
        if (m.startsWith('video/')) return `${base}.webm`;
        if (m.startsWith('audio/')) return `${base}.webm`;
        if (m === 'image/jpeg') return `${base}.jpg`;
        return /\.[a-z0-9]+$/i.test(origName) ? origName : `${base}`;
    }

    async function sniffBlob(blob) {
        try {
            const slice = await blob.slice(0, 16).arrayBuffer();
            const u8 = new Uint8Array(slice);
            return { size: blob.size || 0, type: blob.type || '(none)', head: Array.from(u8) };
        } catch { return { size: blob.size || 0, type: blob.type || '(none)', head: [] }; }
    }

    async function fetchBlobMaybeGunzip(url, name) {
        const res = await fetch(url, { credentials: 'include' });
        const enc = (res.headers.get('content-encoding') || '').toLowerCase();
        const buf = await res.arrayBuffer();
        const isGz = enc.includes('gzip') || /\.gz$/i.test(name || '');
        if (isGz && 'DecompressionStream' in global) {
            // try streaming gunzip so inline previews render plain
            const ds = new DecompressionStream('gzip');
            const out = await new Response(new Response(buf).body.pipeThrough(ds)).blob();
            return out;
        }
        return new Blob([buf], { type: res.headers.get('content-type') || 'application/octet-stream' });
    }

    function fixDownloadLink(aEl, url, name, mt) {
        aEl.rel = 'noopener noreferrer';
        aEl.download = name || 'download';
        aEl.href = url;
        aEl.target = '_blank';
    }

    async function compressFileSmart(file, onProgress) {
        const t0 = performance.now();
        const origName = fileNameOf(file);
        const mt = (file.type || '').toLowerCase();
        const prog = wrapProgress(onProgress, 'compressFileSmart');

        dbg('compressFileSmart.in', { name: origName, size: file.size || 0, type: file.type || '(none)' });

        let result;
        try {
            if (mt.startsWith('video/')) {
                prog(0.02, 'starting');
                const blob = await compressVideoUnder1MB_STRICT(file, prog);
                const mime = blob.type || 'video/webm';
                const name = fixFilenameForType(origName, mime);
                const f = new File([blob], name, { type: mime });
                result = { file: f, blob, encoding: null, filename: name, mime_type: mime };
                dbg('compressFileSmart.video', await sniffBlob(blob));
                return result;
            }

            if (mt.startsWith('audio/')) {
                prog(0.02, 'starting');
                const blob = await compressAudioUnder1MB(file, prog);
                const mime = blob.type || 'audio/webm';
                const name = fixFilenameForType(origName, mime);
                const f = new File([blob], name, { type: mime });
                result = { file: f, blob, encoding: null, filename: name, mime_type: mime };
                dbg('compressFileSmart.audio', await sniffBlob(blob));
                return result;
            }

            if (mt.startsWith('image/')) {
                prog(0.02, 'starting');

                // TIFF or huge images → use ffmpeg fallback; otherwise canvas path
                const isTiff = /image\/(tif|tiff)/i.test(mt) || /\.(tif|tiff)$/i.test(origName);
                const isHuge = (file.size || 0) > 25 * 1024 * 1024;

                let u8;
                if (isTiff || isHuge) {
                    u8 = await transcodeTiffToJpegUnder1MB(file, prog);
                } else {
                    u8 = await compressImageUnder1MB(file, prog);
                }

                const blob = new Blob([u8], { type: 'image/jpeg' });
                const name = /\.(tif|tiff)$/i.test(origName)
                    ? origName.replace(/\.(tif|tiff)$/i, '.jpg')
                    : (/\.[a-z0-9]+$/i.test(origName) ? origName : (origName + '.jpg'));

                const f = new File([blob], name, { type: 'image/jpeg' });
                result = { file: f, blob, encoding: null, filename: name, mime_type: 'image/jpeg' };
                dbg('compressFileSmart.image', await sniffBlob(blob));
                return result;
            }

            // Everything else → prefer passthrough if previewable or ≤ 1MB; gzip only when it helps
            prog(0.02, 'starting');

            const canPreview = isPreviewableMime(mt) || isTextLike(origName, mt);

            // If the file is already under the cap OR is previewable (text/code/PDF), do NOT gzip.
            if ((file.size || 0) <= MAX_BYTES || canPreview) {
                const name = fixFilenameForType(origName, file.type || '');
                const mime = (file.type || 'application/octet-stream');
                const f = (file instanceof File) ? file : new File([file], name, { type: mime });
                result = { file: f, blob: f, encoding: null, filename: name, mime_type: mime };
                dbg('compressFileSmart.other(passthrough)', await sniffBlob(f));
                return result;
            }

            // Otherwise we try gzip to squeeze under 1MB (binary docs, etc.)
            const { blob, encoding } = await gzipGeneric(file, prog);
            const mime = blob.type || (file.type || 'application/octet-stream');
            const name = fixFilenameForType(origName, mime);
            const f = new File([blob], name, { type: mime });
            result = { file: f, blob, encoding, filename: name, mime_type: mime };
            dbg('compressFileSmart.other(gzipped)', { encoding, ...(await sniffBlob(blob)) });
            return result;

        } catch (e) {
            dberr('compressFileSmart.error', e);
            throw e;
        } finally {
            prog(1, 'finalizing');
            dbg('compressFileSmart.done', { dtMs: +(performance.now() - t0).toFixed(1) });
        }
    }

    /* ====== INLINE RENDERERS FOR ATTACHMENTS ======
       Call this from renderMessage(...) fallback branch for non-image/video/audio */
    async function ensureDocxPreviewLoaded() {
        if (global.__docxLoaded) return;
        await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/docx-preview@0.3.4/dist/docx-preview.min.js';
            s.onload = res; s.onerror = rej; document.head.appendChild(s);
        });
        global.__docxLoaded = true;
    }

    function renderAttachmentInline(rootEl, a) {
        const url = `${API}/dm/attachments/${a.id}/download?inline=1`;
        const mt = baseMime(a.mime_type || '');
        const name = a.filename || 'attachment';

        // PDF
        if (mt === 'application/pdf' || extOf(name) === 'pdf') {
            const wrap = document.createElement('div');
            const frame = document.createElement('iframe');
            frame.className = 'att';
            frame.title = name;
            frame.loading = 'lazy';
            frame.style.width = '100%';
            frame.style.height = '420px';
            wrap.appendChild(frame);
            rootEl.appendChild(wrap);

            (async () => {
                try {
                    const blob = await fetchBlobMaybeGunzip(url, name);
                    const obj = URL.createObjectURL(blob);
                    frame.src = obj;
                    // DO NOT revoke onload. Keep alive while the iframe exists.
                    frame.dataset.objurl = obj; // let revokeObjectURLsIn() clean it up later
                } catch {
                    // graceful fallback: plain link (your 3-dot menu still has the real download)
                    const aEl = document.createElement('a');
                    aEl.className = 'att';
                    aEl.href = url; aEl.download = name;
                    aEl.textContent = `📎 ${name} (${niceBytes(a.size || 0)})`;
                    wrap.replaceWith(aEl);
                    fixDownloadLink(aEl, url, name, mt);
                }
            })();
            return;
        }

        // DOCX/DOC (best-effort via docx-preview; otherwise link)
        if (['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'].includes(mt) ||
            ['docx', 'doc'].includes(extOf(name))) {
            const box = document.createElement('div');
            box.className = 'att';
            box.style.border = '1px solid var(--border)';
            box.style.background = '#0e1116';
            box.style.padding = '10px';
            box.innerHTML = `<div class="muted" style="margin-bottom:6px">Previewing ${esc(name)}…</div><div class="docx"></div>`;
            rootEl.appendChild(box);
            (async () => {
                try {
                    await ensureDocxPreviewLoaded();
                    const ab = await (await fetch(url, { credentials: 'include' })).arrayBuffer();
                    const container = box.querySelector('.docx');
                    await window.docx.renderAsync(ab, container);
                } catch (e) {
                    // graceful fallback
                    box.innerHTML = `<a class="att" href="${url}" download="${esc(name)}">📎 ${esc(name)} (${niceBytes(a.size || 0)})</a>`;
                }
            })();
            return;
        }

        // TEXT / CODE (fetch small preview then <pre>)
        if (isTextLike(name, mt)) {
            (async () => {
                try {
                    // note: auto-gunzip, so .js.gz will still show text
                    const blob0 = await fetchBlobMaybeGunzip(url, name);

                    // Show up to ~256KB inline
                    const maxShow = 256 * 1024;
                    if (blob0.size > maxShow) {
                        const aEl = document.createElement('a');
                        aEl.className = 'att';
                        aEl.href = url; aEl.download = name;
                        aEl.textContent = `📎 ${name} (${niceBytes(blob0.size)} — too large to preview)`;
                        rootEl.appendChild(aEl);
                        fixDownloadLink(aEl, url, name, mt);
                        return;
                    }
                    const text = await blob0.text();
                    const pre = document.createElement('pre');
                    pre.className = 'att att-text';
                    pre.style.maxHeight = '420px';
                    pre.style.overflow = 'auto';
                    pre.textContent = text;
                    rootEl.appendChild(pre);
                } catch {
                    const aEl = document.createElement('a');
                    aEl.className = 'att';
                    aEl.href = url; aEl.download = name;
                    aEl.textContent = `📎 ${name}`;
                    rootEl.appendChild(aEl);
                    fixDownloadLink(aEl, url, name, mt);
                }
            })();
            return;
        }

        // Unknown types: just a download link (allowed as long as size ≤ 1MB on upload)
        const aEl = document.createElement('a');
        aEl.className = 'att';
        aEl.href = url; aEl.download = name;
        aEl.textContent = `📎 ${name} (${niceBytes(a.size || 0)})`;
        rootEl.appendChild(aEl);
        fixDownloadLink(aEl, url, name, mt);
    }

    // ---- UMD export + convenience alias ----
    const api = {
        MAX_BYTES,
        getFFmpeg,
        compressFileSmart,
        compressImageUnder1MB,
        compressAudioUnder1MB,
        compressVideoUnder1MB,
        compressVideoUnder1MB_STRICT,
        transcodeTiffToJpegUnder1MB,
        gzipGeneric,
        renderAttachmentInline,
    };

    if (typeof module === 'object' && module.exports) module.exports = api;
    global.Compressors = api;
    if (!global.compressFileSmart) global.compressFileSmart = api.compressFileSmart;

})(typeof window !== 'undefined' ? window : globalThis);
