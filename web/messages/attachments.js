(() => {
    const MA = (window.MessagesApp = window.MessagesApp || {});
    const { API, $, state } = MA;
    const { esc, errMsg } = (MA.utils ||= {});

    // ---- state guards --------------------------------------------------------
    (state.pendingFiles ||= []);

    // Unified, idempotent gate poke (microtask + rAF)
    const pokeGate = (reason = 'attachments') => {
        try {
            Promise.resolve().then(() => MA.syncSendUI?.(`${reason}:micro`));
            requestAnimationFrame(() => MA.syncSendUI?.(`${reason}:raf`));
        } catch { }
    };

    // ---- chips UI ------------------------------------------------------------
    const chipsEl = () => $('att-chips');

    // Remove a pending item by index
    function removePendingAt(i) {
        if (i < 0 || i >= state.pendingFiles.length) return;
        state.pendingFiles.splice(i, 1);
        refreshChips();
    }

    function refreshChips() {
        const root = chipsEl();
        if (!root) return;

        root.innerHTML = '';
        state.pendingFiles.forEach((f, i) => {
            const chip = document.createElement('div');
            chip.className = 'chip';

            if (f.status === 'compressing') {
                const pct = Math.max(0, Math.min(100, Math.round((f.progress || 0) * 100)));
                chip.innerHTML = `
          <div style="display:flex;flex-direction:column;gap:6px;min-width:260px">
            <div>${esc(f.name)} <span class="muted">· ${esc(f.phase || 'compressing')}… ${pct}%</span></div>
            <div class="prog-wrap" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
              <div class="prog ${pct >= 100 ? 'done' : ''}" style="width:${pct}%"></div>
            </div>
          </div>`;
            } else {
                chip.innerHTML = `<span>${esc(f.name)} · ${(f.size / 1024 | 0)} KB</span><span class="x" title="Remove">✕</span>`;
                chip.querySelector('.x').onclick = () => {
                    removePendingAt(i);      // triggers refresh + gate poke inside
                };
            }

            root.appendChild(chip);
        });

        // every render may change "has files?" → refresh gate
        pokeGate('chips:refresh');
    }

    // ---- public attachment ops ----------------------------------------------
    function addCompressingPlaceholder(fileName) {
        const tempId = 'tmp_' + Math.random().toString(36).slice(2);
        state.pendingFiles.push({
            tempId,
            status: 'compressing',
            name: fileName,
            progress: 0,
            phase: 'starting'
        });
        refreshChips();      // renders + gate poke
        return tempId;
    }

    const setCompressProgress = (() => {
        let raf = null;
        const pend = new Map(); // tempId -> {p, phase}

        return (tempId, p, phase) => {
            pend.set(tempId, { p: Math.max(0, Math.min(1, +p || 0)), phase });
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = null;
                // apply all staged updates
                pend.forEach(({ p, phase }, id) => {
                    const it = state.pendingFiles.find(x => x.tempId === id && x.status === 'compressing');
                    if (it) {
                        it.progress = p;
                        if (phase) it.phase = phase;
                    }
                });
                pend.clear();
                refreshChips();  // also pokes the gate
            });
        };
    })();

    // IMPORTANT: do not add if the placeholder was removed while compressing.
    function replaceCompressingWith(tempId, obj) {
        const idx = state.pendingFiles.findIndex(x => x.tempId === tempId && x.status === 'compressing');
        if (idx !== -1) {
            state.pendingFiles.splice(idx, 1, obj);
            refreshChips();   // renders + gate poke
        } else {
            // user removed the placeholder; ignore the finished output
            pokeGate('compress:ignored-finished');
        }
    }

    function addPendingFile(o) {
        state.pendingFiles.push(o);
        refreshChips();
    }

    // ---- file input handler (uses global compressFileSmart) ------------------
    async function handleFileInput(files) {
        for (const file of files) {
            // absurdly huge guard (UX copy kept from your version)
            if (file.size > 10000 * 1024 * 1024) {
                alert('Look pal, the file limit is ONE MB. I can compress stuff, sure, but I cant compress THAT.');
                continue;
            }

            const tempId = addCompressingPlaceholder(file.name);
            try {
                const { blob, encoding } = await window.compressFileSmart(
                    file,
                    (p, phase) => setCompressProgress(tempId, p, phase)
                );

                const u8 = new Uint8Array(await blob.arrayBuffer());
                const outMime = blob.type || 'application/octet-stream';
                const inMime = file.type || '';

                const isVid = /^video\//.test(outMime);
                const isAud = /^audio\//.test(outMime);
                const isImg = /^image\//.test(inMime);

                const safeName =
                    (isVid || isAud) ? file.name.replace(/\.[^.]+$/, '') + '.webm'
                        : isImg ? file.name.replace(/\.[^.]+$/, '') + '.jpg'
                            : file.name + (encoding === 'gzip' ? '.gz' : '');

                replaceCompressingWith(tempId, {
                    name: safeName,
                    type: outMime,
                    buf: u8,
                    size: u8.length,
                    encoding: encoding || null
                });
            } catch (e) {
                // If the placeholder is still present, remove it
                const idx = state.pendingFiles.findIndex(x => x.tempId === tempId);
                if (idx !== -1) state.pendingFiles.splice(idx, 1);
                refreshChips();   // render + gate
                alert(`${file.name}: ${errMsg?.(e) || (e?.message || e)}`);
            }
        }
    }

    // ---- helpers for preview/download (unchanged behavior) -------------------
    async function maybeGunzipBlob(blob, name = '') {
        const isGzName = /\.gz$/i.test(name);
        const isGzType = /application\/(x-)?gzip/i.test(blob?.type || '');
        if (!(isGzName || isGzType)) return blob;
        if (!('DecompressionStream' in window)) return blob;
        try {
            const ds = new DecompressionStream('gzip');
            const s = blob.stream().pipeThrough(ds);
            return await new Response(s).blob();
        } catch {
            return blob;
        }
    }

    async function fetchBlobMaybeGunzip(url, name = '') {
        const res = await fetch(url, { credentials: 'include' });
        let b = await res.blob();
        return maybeGunzipBlob(b, name);
    }

    function blobDownload(name, blob) {
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = name || 'download';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
    }

    function fixDownloadLink(anchorEl, url, name, mime) {
        anchorEl.addEventListener('click', async (e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            try {
                let b = await fetchBlobMaybeGunzip(url, name);
                if (mime && b.type !== mime) b = new Blob([await b.arrayBuffer()], { type: mime });
                blobDownload(name, b);
            } catch (err) {
                window.open(url, '_blank');
            }
        }, { passive: false });
    }

    function niceBytes(n) { const u = ['B', 'KB', 'MB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${Math.round(n)} ${u[i]}`; }
    const baseMime = (mt = '') => (mt || '').split(';')[0].trim().toLowerCase();
    const extOf = (name = '') => { const m = name.match(/\.([^.]+)$/); return m ? m[1].toLowerCase() : ''; };
    function isTextLike(name, mt) {
        const e = extOf(name);
        if ((mt || '').startsWith('text/')) return true;
        const codeish = ['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'yml', 'yaml', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'c', 'cc', 'cpp', 'h', 'hpp', 'go', 'rs', 'py', 'rb', 'php', 'java', 'kt', 'swift', 'sql', 'sh', 'bat', 'ps1'];
        return codeish.includes(e);
    }

    async function ensureDocxPreviewLoaded() {
        if (ensureDocxPreviewLoaded._done) return;
        await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://unpkg.com/docx-preview@0.3.4/dist/docx-preview.min.js';
            s.onload = res; s.onerror = rej; document.head.appendChild(s);
        });
        ensureDocxPreviewLoaded._done = true;
    }

    function renderAttachmentInline(rootEl, a) {
        const url = `${API}/dm/attachments/${a.id}/download?inline=1`;
        const mt = baseMime(a.mime_type || '');
        const name = a.filename || 'attachment';

        // PDF
        if (mt === 'application/pdf' || extOf(name) === 'pdf') {
            const wrap = document.createElement('div');
            const frame = document.createElement('iframe');
            frame.className = 'att'; frame.title = name; frame.loading = 'lazy';
            frame.style.width = '100%'; frame.style.height = '420px';
            wrap.appendChild(frame); rootEl.appendChild(wrap);
            (async () => {
                try {
                    const blob = await fetchBlobMaybeGunzip(url, name);
                    const obj = URL.createObjectURL(blob);
                    frame.src = obj; frame.dataset.objurl = obj;
                } catch {
                    const aEl = document.createElement('a');
                    aEl.className = 'att'; aEl.href = url; aEl.download = name;
                    aEl.textContent = `📎 ${name} (${niceBytes(a.size || 0)})`;
                    wrap.replaceWith(aEl);
                    fixDownloadLink(aEl, url, name, mt);
                }
            })();
            return;
        }

        // DOCX/DOC
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
                } catch {
                    box.innerHTML = `<a class="att" href="${url}" download="${esc(name)}">📎 ${esc(name)} (${niceBytes(a.size || 0)})</a>`;
                }
            })();
            return;
        }

        // TEXT / CODE
        if (isTextLike(name, mt)) {
            (async () => {
                try {
                    const blob0 = await fetchBlobMaybeGunzip(url, name);
                    const maxShow = 256 * 1024;
                    if (blob0.size > maxShow) {
                        const aEl = document.createElement('a');
                        aEl.className = 'att'; aEl.href = url; aEl.download = name;
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
                    aEl.className = 'att'; aEl.href = url; aEl.download = name; aEl.textContent = `📎 ${name}`;
                    rootEl.appendChild(aEl);
                    fixDownloadLink(aEl, url, name, mt);
                }
            })();
            return;
        }

        // Fallback
        const aEl = document.createElement('a');
        aEl.className = 'att'; aEl.href = url; aEl.download = name;
        aEl.textContent = `📎 ${name} (${niceBytes(a.size || 0)})`;
        rootEl.appendChild(aEl);
        fixDownloadLink(aEl, url, name, mt);
    }

    // ---- expose --------------------------------------------------------------
    window.fetchBlobMaybeGunzip = fetchBlobMaybeGunzip;

    Object.assign(MA, {
        addPendingFile, // handy alias
    });

    MA.attachments = {
        refreshChips,
        addCompressingPlaceholder,
        setCompressProgress,
        replaceCompressingWith,
        addPendingFile,
        handleFileInput,
        removePendingAt,

        // helpers
        maybeGunzipBlob,
        fetchBlobMaybeGunzip,
        blobDownload,
        fixDownloadLink,
        niceBytes,
        baseMime,
        extOf,
        isTextLike,
        renderAttachmentInline,
        ensureDocxPreviewLoaded
    };

    // run once in case there were pending items set before load
    refreshChips();
})();
