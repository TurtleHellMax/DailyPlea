// web/user.js
console.log("[user.js] loaded");

(() => {
    "use strict";

    const API_BASE = "http://localhost:3000/api";
    const MAX_BYTES = 1 * 1024 * 1024;
    const PNG_MIME = "image/png";
    const ZOOM_MIN_REL = 0.5;
    const ZOOM_MAX_REL = 14.0;

    const $id = (id) => document.getElementById(id);
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

    const state = {
        csrf: null,
        slug: null,
        profile: null,
        me: null,
        original: {},
        // photo editor
        img: null, zoom: 1, rot: 0, panX: 0, panY: 0,
        dragging: false, dragStart: { x: 0, y: 0 }, panStart: { x: 0, y: 0 },
        // bio
        bioHTML: "",
        originalBioHTML: "",
        photoDataUrl: null,
    };

    // ==== BIO constants ====
    const FONT_STACK_TARGET = "'Voice1','Montserrat',system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif";
    const BIO_ALLOWED_TAGS = new Set(["B", "STRONG", "I", "EM", "SPAN", "BR"]);
    const BIO_MIN_EM = 0.8;
    const BIO_MAX_EM = 1.6;
    const BIO_MAX_LINES = 3;
    const ZWSP = "\u200B"; // zero-width space for caret stability

    // DOM refs
    const bioEdit = $id("bio-edit");
    const bioPrev = $id("bio-preview");
    const msgBio = $id("msg-bio");
    const btnSave = $id("btn-save");

    /* ============ CSRF + API ============ */
    async function fetchCsrf() {
        const r = await fetch(API_BASE.replace("/api", "") + "/api/csrf", { credentials: "include" });
        const j = await r.json().catch(() => ({}));
        const tok = j?.token ?? j?.csrfToken ?? j?.csrf ?? null;
        if (!r.ok || !tok) throw new Error("csrf");
        state.csrf = tok;
        return tok;
    }

    async function api(path, opts = {}) {
        const method = (opts.method || "GET").toUpperCase();
        const headers = Object.assign({}, opts.headers || {});
        if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";
        if (method !== "GET" && !headers["x-csrf-token"]) {
            if (!state.csrf) await fetchCsrf();
            headers["x-csrf-token"] = state.csrf;
        }
        const r = await fetch(API_BASE + path, { method, headers, credentials: "include", body: opts.body });
        const txt = await r.text();
        let data;
        try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
        if (!r.ok) {
            const err = new Error(data?.error || r.statusText);
            err.status = r.status; err.data = data; err.detail = data?.detail || txt;
            throw err;
        }
        return data;
    }

    /* ============ UI helpers ============ */
    function setMsg(el, text, ok = false) {
        if (!el) return;
        el.textContent = text || "";
        el.className = "msg " + (text ? (ok ? "ok" : "err") : "");
    }
    function setAvatar(src) {
        $id("hdr-img").src = src || "";
        $id("pf-thumb").src = src || "";
        console.log("[user.js] avatar set", !!src ? "(has image)" : "(empty)");
    }
    function fmtDate(s) { try { return new Date(s).toLocaleDateString(); } catch { return s || "—"; } }

    /* ============ Zoom mapping ============ */
    function relFromNormalizedSlider(t) {
        t = clamp(Number(t), 0, 1);
        if (t <= 0.5) { const u = t / 0.5; return ZOOM_MIN_REL * Math.pow(1 / ZOOM_MIN_REL, u); }
        const u = (t - 0.5) / 0.5; return Math.pow(ZOOM_MAX_REL, u);
    }

    /* ============ Photo editor ============ */
    const canvas = $id("stage");
    const ctx = canvas?.getContext("2d");
    const zoomCtl = $id("ctl-zoom");
    const rotCtl = $id("ctl-rot");
    const drop = $id("drop");
    const msgPhoto = $id("msg-photo");

    function drawEditor() {
        if (!ctx || !canvas) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!state.img) return;

        const cw = canvas.width, ch = canvas.height;
        ctx.save();
        ctx.translate(cw / 2 + state.panX, ch / 2 + state.panY);
        ctx.rotate(state.rot * Math.PI / 180);
        const baseScale = Math.min(cw / state.img.width, ch / state.img.height);
        const s = baseScale * state.zoom;
        ctx.scale(s, s);
        ctx.drawImage(state.img, -state.img.width / 2, -state.img.height / 2);
        ctx.restore();

        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,.18)";
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, cw - 2, ch - 2);
        ctx.restore();
    }

    function paintBlank() {
        if (!ctx || !canvas) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    function resetEditor() {
        state.img = null; state.zoom = 1; state.rot = 0; state.panX = 0; state.panY = 0;
        if (zoomCtl) { if (zoomCtl.min === "0" && zoomCtl.max === "1") zoomCtl.value = "0.5"; else zoomCtl.value = "1.0"; }
        if (rotCtl) rotCtl.value = "0";
        paintBlank();
        setMsg(msgPhoto, "");
    }

    function setImageFromFile(file) {
        if (!file) return;
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            state.img = img;
            state.zoom = 1; state.rot = 0; state.panX = 0; state.panY = 0;
            if (zoomCtl) { if (zoomCtl.min === "0" && zoomCtl.max === "1") zoomCtl.value = "0.5"; else zoomCtl.value = "1.0"; }
            if (rotCtl) rotCtl.value = "0";
            drawEditor();
            console.log("[user.js] image loaded", img.naturalWidth, "x", img.naturalHeight);
        };
        img.onerror = () => setMsg(msgPhoto, "Could not load image");
        img.src = url;
    }

    if (canvas) {
        canvas.addEventListener("mousedown", (e) => {
            if (!state.img) return;
            state.dragging = true;
            state.dragStart = { x: e.clientX, y: e.clientY };
            state.panStart = { x: state.panX, y: state.panY };
        });
        window.addEventListener("mousemove", (e) => {
            if (!state.dragging) return;
            state.panX = state.panStart.x + (e.clientX - state.dragStart.x);
            state.panY = state.panStart.y + (e.clientY - state.dragStart.y);
            drawEditor();
        });
        window.addEventListener("mouseup", () => { state.dragging = false; });
    }

    if (zoomCtl) {
        zoomCtl.addEventListener("input", () => {
            if (zoomCtl.min === "0" && zoomCtl.max === "1") {
                state.zoom = relFromNormalizedSlider(zoomCtl.value);
            } else {
                state.zoom = parseFloat(zoomCtl.value) || 1;
            }
            drawEditor();
        });
    }
    if (rotCtl) {
        rotCtl.addEventListener("input", () => {
            state.rot = parseFloat(rotCtl.value) || 0;
            drawEditor();
        });
    }

    const fileInput = $id("file");
    if (fileInput) {
        fileInput.addEventListener("change", (ev) => {
            const f = ev.target.files && ev.target.files[0];
            setImageFromFile(f);
        });
    }
    if (drop) {
        ["dragenter", "dragover", "dragleave", "drop"].forEach(evt => {
            drop.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
        });
        drop.addEventListener("drop", (e) => {
            const f = e.dataTransfer.files && e.dataTransfer.files[0];
            setImageFromFile(f);
        });
    }

    /* ============ Account form + saving ============ */
    const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;
    const msgAccount = $id("msg-account");
    function sanitizeEmail(x) { const s = String(x || "").trim(); return s || ""; }
    function isEmail(x) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(x || "")); }
    function sanitizePhone(x) {
        if (!x) return "";
        let s = String(x).trim();
        const hasPlus = s.startsWith("+");
        s = s.replace(/[^\d+]/g, "");
        return hasPlus ? ("+" + s.replace(/[+]/g, "")) : s.replace(/[+]/g, "");
    }
    function isPhone(x) { return /^\+?[0-9]{7,15}$/.test(String(x || "")); }
    function strongPassword(pw) {
        const s = String(pw || "");
        return (s.length > 6 && s.length < 32 && /[A-Z]/.test(s) && /[0-9]/.test(s) && /[^A-Za-z0-9]/.test(s));
    }

    const fUsername = $id("f-username");
    const fEmail = $id("f-email");
    const fPhone = $id("f-phone");
    const fNew = $id("f-newpw");
    const fConfirm = $id("f-confirm");
    const fCurrent = $id("f-current");
    const pwExtra = $id("pw-extra");

    if (fNew && pwExtra) {
        fNew.addEventListener("input", () => {
            const on = fNew.value.length > 0;
            pwExtra.style.display = on ? "" : "none";
            if (!on) { fConfirm.value = ""; fCurrent.value = ""; }
        });
    }

    $id("btn-reset")?.addEventListener("click", resetEditor);

    $id("btn-apply")?.addEventListener("click", async () => {
        if (!state.img) { setMsg(msgPhoto, "Choose an image first."); return; }
        const size = 512;
        const out = document.createElement("canvas");
        out.width = size; out.height = size;
        const ox = out.getContext("2d");
        ox.clearRect(0, 0, size, size);
        ox.save();
        ox.translate(size / 2 + (state.panX * (size / canvas.width)),
            size / 2 + (state.panY * (size / canvas.height)));
        ox.rotate(state.rot * Math.PI / 180);
        const baseScale = Math.min(size / state.img.width, size / state.img.height);
        const s = baseScale * state.zoom;
        ox.scale(s, s);
        ox.drawImage(state.img, -state.img.width / 2, -state.img.height / 2);
        ox.restore();

        const blob = await new Promise(res => out.toBlob(res, PNG_MIME));
        if (!blob) { setMsg(msgPhoto, "Failed to encode PNG"); return; }
        if (blob.size > MAX_BYTES) {
            setMsg(msgPhoto, "Processed image is too large (> 1 MB). Please crop/zoom more or choose a smaller image.");
            return;
        }
        const dataUrl = await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.readAsDataURL(blob);
        });
        state.photoDataUrl = dataUrl;
        setAvatar(dataUrl);
        setMsg(msgPhoto, "Photo ready. Click “Save changes” to upload.", true);
    });

    $id("btn-cancel")?.addEventListener("click", () => {
        if (fUsername) fUsername.value = state.original.username || "";
        if (fEmail) fEmail.value = state.original.email || "";
        if (fPhone) fPhone.value = state.original.phone || "";
        setAvatar(state.original.photo || "");
        if (fNew) fNew.value = "";
        if (fConfirm) fConfirm.value = "";
        if (fCurrent) fCurrent.value = "";
        if (pwExtra) pwExtra.style.display = "none";
        state.photoDataUrl = null;
        setMsg(msgAccount, "");
        setMsg(msgPhoto, "");

        resetEditor();

        // Bio reset
        state.bioHTML = state.originalBioHTML || "";
        if (bioEdit) bioEdit.innerHTML = state.bioHTML;
        if (bioPrev) { bioPrev.innerHTML = state.bioHTML; applyPreviewClamp(); checkBioFits(); }
        setMsg(msgBio, "");
        if (btnSave) btnSave.disabled = false;
    });

    $id("btn-save")?.addEventListener("click", async () => {
        setMsg(msgAccount, "");

        if (!isOwner(state.profile, state.me, state.slug)) {
            setMsg(msgAccount, "You must be the owner to edit this profile.");
            return;
        }

        const username = fUsername?.value.trim() || "";
        const email = sanitizeEmail(fEmail?.value);
        const phone = sanitizePhone(fPhone?.value);
        const newpw = fNew?.value || "";
        const confirm = fConfirm?.value || "";
        const current = fCurrent?.value || "";

        if (username && !USERNAME_RE.test(username)) { setMsg(msgAccount, "Username must be 3–24: letters, numbers, underscore."); return; }
        if (email && !isEmail(email)) { setMsg(msgAccount, "Invalid email."); return; }
        if (phone && !isPhone(phone)) { setMsg(msgAccount, "Invalid phone."); return; }

        const body = {};
        if (username && username !== state.original.username) body.username = username;

        const emailEnabled = fEmail && !fEmail.disabled;
        const phoneEnabled = fPhone && !fPhone.disabled;
        if (emailEnabled && email && email !== state.original.email) body.email = email;
        if (phoneEnabled && phone && phone !== state.original.phone) body.phone = phone;

        if (state.photoDataUrl) body.profile_photo = state.photoDataUrl;

        if (newpw.length > 0) {
            if (!strongPassword(newpw)) { setMsg(msgAccount, "Password must be 7–31 chars and include a capital, a number, and a symbol."); return; }
            if (newpw !== confirm) { setMsg(msgAccount, "Password confirmation does not match."); return; }
            body.password = newpw;
            body.current_password = current || "";
        }

        if (bioEdit) {
            const cleaned = sanitizeBioHTML(bioEdit.innerHTML);
            if (cleaned !== (state.originalBioHTML || "")) body.bio_html = cleaned;
        }

        if (Object.keys(body).length === 0) {
            setMsg(msgAccount, "No changes to save.", false);
            return;
        }

        try {
            await fetchCsrf();
            let res;
            try {
                res = await api(`/users/by-first/${encodeURIComponent(state.slug)}`, { method: "PATCH", body: JSON.stringify(body) });
            } catch (e1) {
                try {
                    res = await api(`/users/by_username/${encodeURIComponent(state.slug)}`, { method: "PATCH", body: JSON.stringify(body) });
                } catch (e2) {
                    res = await api(`/users/${encodeURIComponent(state.slug)}`, { method: "PATCH", body: JSON.stringify(body) });
                }
            }

            const updated = res.user || {};
            if (state.me && updated.id === state.me.id) state.me = { ...state.me, ...updated };
            if (state.profile && updated.id === state.profile.id) state.profile = { ...state.profile, ...updated };

            $id("hdr-username").textContent =
                (isOwner(state.profile, state.me, state.slug) && state.me?.username)
                    ? state.me.username
                    : (state.profile.username || state.profile.first_username || state.slug);

            if ("profile_photo" in body) setAvatar(state.photoDataUrl);
            if ("bio_html" in body) state.originalBioHTML = body.bio_html;

            if ("username" in body) state.original.username = updated.username || state.original.username;
            if ("email" in body) state.original.email = updated.email || "";
            if ("phone" in body) state.original.phone = updated.phone || "";
            if ("profile_photo" in body) state.original.photo = state.photoDataUrl;

            if (fNew) fNew.value = "";
            if (fConfirm) fConfirm.value = "";
            if (fCurrent) fCurrent.value = "";
            if (pwExtra) pwExtra.style.display = "none";
            state.photoDataUrl = null;
            setMsg(msgAccount, "Saved!", true);
        } catch (e) {
            const code = e?.data?.error || "";
            if (code === "username_taken") return setMsg(msgAccount, "That username is taken.");
            if (code === "invalid_username") return setMsg(msgAccount, "Invalid username.");
            if (code === "username_banned") return setMsg(msgAccount, "Username is not allowed.");
            if (code === "email_taken") return setMsg(msgAccount, "That email is already in use.");
            if (code === "phone_taken") return setMsg(msgAccount, "That phone is already in use.");
            if (code === "bad_current_password") return setMsg(msgAccount, "Current password is incorrect.");
            setMsg(msgAccount, e.detail || e.message || "Save failed.");
            console.error("[user.js] save error", e);
        }
    });

    /* ============ Owner & profile fetch ============ */
    function isOwner(profile, me, slug) {
        if (!me) return false;
        const pid = Number(profile?.id);
        const mid = Number(me?.id);
        if (Number.isFinite(pid) && Number.isFinite(mid) && pid === mid) return true;
        const s = String(slug || "").toLowerCase();
        const u1 = String(me.username || "").toLowerCase();
        const u0 = String(me.first_username || "").toLowerCase();
        if (s && (s === u1 || s === u0)) return true;
        return false;
    }
    function pickUser(payload) {
        if (!payload) return null;
        if (payload.user && typeof payload.user === "object") return payload.user;
        if (payload.ok && payload.user) return payload.user;
        if (Array.isArray(payload) && payload.length && typeof payload[0] === "object") return payload[0];
        if (typeof payload === "object" && ("id" in payload || "username" in payload || "first_username" in payload)) return payload;
        if (payload.items && Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === "object") return payload.items[0];
        return null;
    }
    async function fetchProfileBySlug(slug) {
        const tries = [
            `/users/by-first/${encodeURIComponent(slug)}`,
            `/users/by_username/${encodeURIComponent(slug)}`,
            `/users/resolve?username=${encodeURIComponent(slug)}`,
            `/users/${encodeURIComponent(slug)}`,
            `/users?first_username=${encodeURIComponent(slug)}`
        ];
        for (const path of tries) {
            try { const j = await api(path); const u = pickUser(j); if (u) return u; }
            catch { /* try next */ }
        }
        return null;
    }
    function extractSlugFromPath(path) {
        const p = path.replace(/\/+$/, "");
        const m = p.match(/^\/user\/([^\/?#]+)(?:\/edit)?(?:[\/?#]|$)/i);
        if (m) return decodeURIComponent(m[1]);
        const parts = p.split("/").filter(Boolean);
        const i = parts.indexOf("user");
        if (i !== -1 && parts[i + 1]) return decodeURIComponent(parts[i + 1]);
        return "";
    }

    function closestSizedSpan(node) {
        while (node && node !== bioEdit) {
            if (node.nodeType === 1 && node.tagName === "SPAN") {
                if (node.style && node.style.fontSize) return node;
            }
            node = node.parentNode;
        }
        return null;
    }

    /* ============ GLYPH support detection ============ */
    const __glyphCanvas = document.createElement("canvas");
    const __glyphCtx = __glyphCanvas.getContext("2d");
    const __glyphCache = new Map();
    function hasGlyph(ch) {
        // allow common control/invisible chars in editor
        if (ch === "\n" || ch === "\r" || ch === "\t" || ch === "\u200B" || ch === "\u200C" || ch === "\u2060") return true;
        if (__glyphCache.has(ch)) return __glyphCache.get(ch);

        const size = 24;
        const bases = ["monospace", "serif", "sans-serif"];
        function widthWith(font) { __glyphCtx.font = `${size}px ${font}`; return __glyphCtx.measureText(ch).width; }
        const baseW = bases.map(b => widthWith(b));
        const testW = bases.map(b => widthWith(`${FONT_STACK_TARGET}, ${b}`));
        const supported = testW.some((w, i) => Math.abs(w - baseW[i]) > 0.01);
        __glyphCache.set(ch, supported);
        return supported;
    }
    function stripUnsupportedChars(str) {
        let out = "";
        for (const ch of String(str)) if (hasGlyph(ch)) out += ch;
        return out;
    }

    /* ============ BIO sanitizer (keep one trailing <br>, collapse multiples) ============ */
    function sanitizeBioHTML(inputHTML) {
        const BLOCKY = new Set(["P", "DIV", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6"]);

        // strip zero-width chars so they never leak to preview/save
        const raw = String(inputHTML || "").replace(/[\u200B\u200C\u2060]/g, "");
        const wrapper = document.createElement("div");
        wrapper.innerHTML = raw;

        (function walk(node) {
            const kids = Array.from(node.childNodes);
            for (const n of kids) {
                if (n.nodeType === Node.TEXT_NODE) {
                    n.textContent = stripUnsupportedChars(n.textContent).replace(/[ \t\u00A0]+/g, " ");
                    continue;
                }
                if (n.nodeType === Node.ELEMENT_NODE) {
                    const tag = n.tagName.toUpperCase();

                    if (!BIO_ALLOWED_TAGS.has(tag)) {
                        if (BLOCKY.has(tag)) {
                            const frag = document.createDocumentFragment();
                            while (n.firstChild) frag.appendChild(n.firstChild);
                            frag.appendChild(document.createElement("br"));
                            n.replaceWith(frag);
                            continue;
                        }
                        while (n.firstChild) node.insertBefore(n.firstChild, n);
                        node.removeChild(n);
                        continue;
                    }

                    // keep only font-size on span
                    for (const a of Array.from(n.attributes)) {
                        if (n.tagName === "SPAN" && a.name.toLowerCase() === "style") {
                            const size = /font-size\s*:\s*([^;]+)/i.exec(a.value || "");
                            n.removeAttribute("style");
                            if (size) {
                                const raw = (size[1] || "").trim();
                                let em = 1;
                                if (raw.endsWith("em")) em = parseFloat(raw);
                                else if (raw.endsWith("px")) em = (parseFloat(raw) / 16);
                                else if (raw.endsWith("%")) em = (parseFloat(raw) / 100);
                                else if (/^\d+(\.\d+)?$/.test(raw)) em = parseFloat(raw);
                                if (!isFinite(em)) em = 1;
                                em = Math.max(BIO_MIN_EM, Math.min(BIO_MAX_EM, em));
                                n.setAttribute("style", `font-size:${em.toFixed(3)}em`);
                            }
                        } else {
                            n.removeAttribute(a.name);
                        }
                    }
                    walk(n);
                } else {
                    node.removeChild(n);
                }
            }
        })(wrapper);

        // convert raw newlines to <br>
        wrapper.innerHTML = wrapper.innerHTML
            .replace(/\r\n?/g, "\n")
            .replace(/\n/g, "<br>");

        // collapse any 2+ consecutive <br> to ONE
        wrapper.innerHTML = wrapper.innerHTML.replace(/(?:<br\s*\/?>\s*){2,}/gi, "<br>");

        // trim spaces around <br>
        const out = wrapper.innerHTML
            .replace(/\s+(<br\s*\/?>)/gi, "$1")
            .replace(/(<br\s*\/?>)\s+/gi, "$1")
            .trim();

        return out;
    }

    function enforceGlyphsOnEditor() {
        if (!bioEdit) return;
        const cleaned = sanitizeBioHTML(bioEdit.innerHTML);
        if (cleaned !== bioEdit.innerHTML) {
            const sel = window.getSelection();
            bioEdit.innerHTML = cleaned;
            // keep caret at end (simple + reliable)
            if (sel && bioEdit.lastChild) {
                sel.removeAllRanges();
                const r = document.createRange();
                r.selectNodeContents(bioEdit);
                r.collapse(false);
                sel.addRange(r);
            }
        }
    }

    function setBioMessage(text, ok = false) { setMsg(msgBio, text, ok); }

    // hidden measuring div
    let __bioMeasureDiv = null;
    function ensureMeasureDiv() {
        if (__bioMeasureDiv) return __bioMeasureDiv;
        __bioMeasureDiv = document.createElement("div");
        Object.assign(__bioMeasureDiv.style, {
            position: "absolute", left: "-10000px", top: "-10000px",
            visibility: "hidden", pointerEvents: "none",
            whiteSpace: "pre-wrap", wordBreak: "break-word",
            boxSizing: "border-box", margin: "0"
        });
        document.body.appendChild(__bioMeasureDiv);
        return __bioMeasureDiv;
    }

    function getLineHeight(pxFontSize, cssLineHeight) {
        if (!cssLineHeight || cssLineHeight === "normal") {
            return (parseFloat(pxFontSize || "16") || 16) * 1.25;
        }
        const n = parseFloat(cssLineHeight);
        if (cssLineHeight.endsWith("px")) return n;
        if (cssLineHeight.endsWith("em")) return n * (parseFloat(pxFontSize || "16") || 16);
        return n;
    }

    function applyPreviewClamp() {
        if (!bioPrev) return;
        // ensure natural height
        bioPrev.style.display = "block";
        bioPrev.style.overflow = "visible";
        bioPrev.style.maxHeight = "none";
        bioPrev.style.webkitLineClamp = "unset";
        bioPrev.style.webkitBoxOrient = "initial";
    }

    function countLinesForHTML(html) {
        if (!bioPrev) return 1;
        const cs = getComputedStyle(bioPrev);
        const m = ensureMeasureDiv();
        m.style.fontFamily = cs.fontFamily;
        m.style.fontSize = cs.fontSize;
        m.style.fontWeight = cs.fontWeight;
        m.style.fontStyle = cs.fontStyle;
        m.style.lineHeight = cs.lineHeight;
        m.style.padding = cs.padding;
        m.style.border = "0";
        m.style.width = bioPrev.clientWidth + "px";
        m.innerHTML = html;

        const lh = getLineHeight(cs.fontSize, cs.lineHeight);
        const padTop = parseFloat(cs.paddingTop) || 0;
        const padBottom = parseFloat(cs.paddingBottom) || 0;
        const contentH = m.scrollHeight - padTop - padBottom;
        return Math.ceil(contentH / lh);
    }

    function checkBioFits() {
        if (!bioPrev) return true;
        applyPreviewClamp();

        const cs = getComputedStyle(bioPrev);
        const lh = getLineHeight(cs.fontSize, cs.lineHeight);
        const lines = countLinesForHTML(bioPrev.innerHTML);
        const fits = lines <= BIO_MAX_LINES;

        if (!fits) {
            setBioMessage(`Bio exceeds ${BIO_MAX_LINES} lines. Trim text or reduce size.`);
            if (btnSave) btnSave.disabled = true;
        } else {
            setBioMessage("");
            if (btnSave) btnSave.disabled = false;
        }
        return fits;
    }

    function updateBioPreviewFromEditor() {
        if (!bioEdit || !bioPrev) return;
        const cleaned = sanitizeBioHTML(bioEdit.innerHTML);
        state.bioHTML = cleaned;
        bioPrev.innerHTML = cleaned;
        checkBioFits();
    }

    function clampSizeEm(em) {
        return Math.max(BIO_MIN_EM, Math.min(BIO_MAX_EM, em || 1));
    }

    function pxFromEm(em) {
        // Use px in the editor to avoid em compounding. Preview/save will px→em.
        return (clampSizeEm(em) * 16); // base 16px
    }

    // Merge adjacent <span style="font-size:Xpx"> siblings to keep DOM tidy
    function mergeAdjacentSameSizeSpans(root) {
        const spans = root.querySelectorAll('span[style*="font-size"]');
        spans.forEach(sp => {
            const size = sp.style.fontSize;
            const next = sp.nextSibling;
            if (next && next.nodeType === 1 && next.tagName === 'SPAN' && next.style.fontSize === size) {
                while (next.firstChild) sp.appendChild(next.firstChild);
                next.remove();
            }
        });
    }

    /* ============ Load profile + me, fill header/form ============ */
    async function load() {
        state.slug = extractSlugFromPath(location.pathname);
        $id("hdr-slug").textContent = state.slug;

        const [profileUser, meRaw] = await Promise.all([
            fetchProfileBySlug(state.slug),
            api("/auth/me").catch(() => null)
        ]);

        state.me = meRaw ? (meRaw.user || meRaw) : null;
        state.profile = profileUser || (isOwner(null, state.me, state.slug) ? state.me : null);

        if (!state.profile) {
            setMsg(msgAccount, "Profile not found", false);
            console.error("[user.js] profile load failed (no user for slug)");
            return;
        }

        const owner = isOwner(state.profile, state.me, state.slug);
        const headerName = (owner && state.me?.username)
            ? state.me.username
            : (state.profile.username || state.profile.first_username || state.slug);

        $id("hdr-username").textContent = headerName;
        $id("hdr-joined").textContent = fmtDate(state.profile.created_at);
        setAvatar(state.profile.profile_photo || "");

        if (fUsername) fUsername.value = state.profile.username || (owner ? (state.me.username || "") : "");

        if (owner) {
            if (fEmail) { fEmail.value = state.me.email || ""; fEmail.disabled = false; }
            if (fPhone) { fPhone.value = state.me.phone || ""; fPhone.disabled = false; }
            $id("f-newpw") && ($id("f-newpw").disabled = false);
            setMsg(msgAccount, "");
            if (bioEdit) { bioEdit.contentEditable = "true"; bioEdit.setAttribute("aria-readonly", "false"); }
        } else {
            if (fEmail) { fEmail.value = ""; fEmail.disabled = true; }
            if (fPhone) { fPhone.value = ""; fPhone.disabled = true; }
            $id("f-newpw") && ($id("f-newpw").disabled = true);
            setMsg(msgAccount, "Viewing public profile (read-only). Login as this user to edit.", false);
            if (bioEdit) { bioEdit.contentEditable = "false"; bioEdit.setAttribute("aria-readonly", "true"); }
        }

        const incomingBio = state.profile.bio_html || state.profile.bio || "";
        state.originalBioHTML = sanitizeBioHTML(incomingBio);

        if (bioEdit) bioEdit.innerHTML = state.originalBioHTML;
        if (bioPrev) {
            bioPrev.innerHTML = state.originalBioHTML;
            requestAnimationFrame(() => { applyPreviewClamp(); checkBioFits(); });
        }

        state.original = {
            username: fUsername?.value || "",
            email: fEmail?.value || "",
            phone: fPhone?.value || "",
            photo: state.profile.profile_photo || null
        };
    }

    function placeCaretInsideEnd(el) {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
    }

    function applyFontSizeEm(emVal) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        const range = sel.getRangeAt(0);

        const px = pxFromEm(emVal);
        const pxStr = px.toFixed(2) + "px";

        if (range.collapsed) {
            // No selection: drop a sized span so next typed chars inherit this fixed px size.
            const span = document.createElement("span");
            span.style.fontSize = pxStr;
            span.appendChild(document.createTextNode(ZWSP));
            range.insertNode(span);
            // Caret inside span
            const r = document.createRange();
            r.selectNodeContents(span);
            r.collapse(false);
            sel.removeAllRanges();
            sel.addRange(r);

            updateBioPreviewFromEditor();
            return;
        }

        // Non-collapsed: apply size to exactly the selected characters.
        // Walk text nodes that intersect the range and wrap only the selected slices.
        const walker = document.createTreeWalker(
            range.commonAncestorContainer,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode(node) {
                    // Skip empty text nodes
                    if (!node.data || !node.data.length) return NodeFilter.FILTER_REJECT;
                    // Only consider nodes that intersect the selection
                    return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                }
            }
        );

        const touched = [];
        while (walker.nextNode()) {
            let node = walker.currentNode;

            // Determine slice [start,end) within this text node that is inside the range
            let start = 0;
            let end = node.data.length;

            if (node === range.startContainer) start = range.startOffset;
            if (node === range.endContainer) end = Math.min(end, range.endOffset);

            // If both start & end containers are the same node, both adjustments apply
            if (range.startContainer === node && range.endContainer === node) {
                start = range.startOffset;
                end = range.endOffset;
            }

            if (start >= end) continue;

            // Split off the leading part if needed
            if (start > 0) {
                node = node.splitText(start);
                end = end - start;
            }
            // Split off the trailing part if needed
            if (end < node.data.length) {
                node.splitText(end);
            }

            // Wrap the exact piece with a fixed px size (no em compounding)
            const wrap = document.createElement("span");
            wrap.style.fontSize = pxStr;
            node.parentNode.replaceChild(wrap, node);
            wrap.appendChild(node);
            touched.push(wrap);
        }

        // Put caret at the end of the last wrapped run
        if (touched.length) {
            mergeAdjacentSameSizeSpans(bioEdit);
            const last = touched[touched.length - 1];
            const r = document.createRange();
            r.setStartAfter(last);
            r.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r);
        }

        updateBioPreviewFromEditor();
    }

    /* ============ BIO editor bindings ============ */
    function setupBioEditor() {
        if (!bioEdit || !bioPrev) return;

        // Make the editor display newlines like a textarea
        bioEdit.style.whiteSpace = "pre-wrap";
        bioEdit.style.wordBreak = "break-word";

        // Enter -> insert a single newline character
        bioEdit.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const sel = window.getSelection();
                if (sel && sel.rangeCount) {
                    const range = sel.getRangeAt(0);
                    range.deleteContents();

                    // Insert a real newline (we render it via white-space: pre-wrap)
                    const nl = document.createTextNode("\n");
                    range.insertNode(nl);

                    // Find the active font-size at the caret and carry it
                    const sizedAncestor = closestSizedSpan(nl.previousSibling || nl.parentNode);
                    if (sizedAncestor && sizedAncestor.style && sizedAncestor.style.fontSize) {
                        const carry = document.createElement("span");
                        carry.style.fontSize = sizedAncestor.style.fontSize;
                        carry.appendChild(document.createTextNode(ZWSP));
                        // place the carry span immediately after the newline
                        const r2 = document.createRange();
                        r2.setStartAfter(nl);
                        r2.collapse(true);
                        r2.insertNode(carry);
                        // move caret inside the carry span
                        const r3 = document.createRange();
                        r3.selectNodeContents(carry);
                        r3.collapse(false);
                        sel.removeAllRanges();
                        sel.addRange(r3);
                    } else {
                        // no active size → just stabilize caret with ZWSP text
                        const zw = document.createTextNode(ZWSP);
                        const r2 = document.createRange();
                        r2.setStartAfter(nl);
                        r2.collapse(true);
                        r2.insertNode(zw);
                        r2.setStartAfter(zw);
                        r2.setEndAfter(zw);
                        sel.removeAllRanges();
                        sel.addRange(r2);
                    }
                } else {
                    document.execCommand("insertText", false, "\n" + ZWSP);
                }
                updateBioPreviewFromEditor();
            }
        });

        // Block unsupported glyphs while typing
        bioEdit.addEventListener("beforeinput", (e) => {
            if (e.inputType === "insertText" && typeof e.data === "string") {
                const allowed = stripUnsupportedChars(e.data);
                if (!allowed.length) { e.preventDefault(); return; }
                if (allowed !== e.data) {
                    e.preventDefault();
                    document.execCommand("insertText", false, allowed);
                }
            }
        });

        // Sanitize paste (limit formatting; keep line breaks)
        bioEdit.addEventListener("paste", (e) => {
            e.preventDefault();
            const dt = e.clipboardData || window.clipboardData;
            const html = dt.getData("text/html");
            const txt = dt.getData("text/plain");
            const src = html && /<\/?[a-z]/i.test(html) ? html : (txt || "");
            const cleaned = sanitizeBioHTML(src);
            document.execCommand("insertHTML", false, cleaned);
            // no enforceGlyphsOnEditor() here
            updateBioPreviewFromEditor();
        });

        bioEdit.addEventListener("input", () => {
            // Do not sanitize the editor here — it destroys caret/typing spans.
            updateBioPreviewFromEditor();
        });

        // Toolbar: Bold / Italic
        $id("bio-bold")?.addEventListener("click", () => {
            document.execCommand("bold");
            enforceGlyphsOnEditor();
            updateBioPreviewFromEditor();
        });
        $id("bio-italic")?.addEventListener("click", () => {
            document.execCommand("italic");
            enforceGlyphsOnEditor();
            updateBioPreviewFromEditor();
        });

        // Toolbar: Size (wrap selection with <span style="font-size:…em">)
        $id("bio-size")?.addEventListener("change", (e) => {
            const val = parseFloat(e.target.value);
            applyFontSizeEm(val);
        });

        // keep existing clamp/fit checks
        let rafId = 0;
        window.addEventListener("resize", () => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => { applyPreviewClamp(); checkBioFits(); });
        });
        applyPreviewClamp();
    }

    function mountPleaHubOnProfile() {
        if (document.querySelector(".plea-hub-btn")) return;
        const a = document.createElement("a");
        a.href = "/pleas/";
        a.className = "plea-hub-btn";
        a.setAttribute("aria-label", "Open Plea Select");
        const img = new Image();
        img.src = "/icons/plea-hub.png";
        img.alt = "Plea Select";
        img.decoding = "async";
        img.loading = "eager";
        img.draggable = false;
        a.appendChild(img);
        a.addEventListener("click", () => { try { sessionStorage.setItem("plea:return", "profile"); } catch { } }, { capture: true });
        document.body.appendChild(a);
        requestAnimationFrame(() => a.classList.add("is-show"));
    }

    /* ============ Kick off ============ */
    function init() {
        console.log("[user.js] DOM ready");
        if (ctx && canvas) {
            ctx.fillStyle = "#111827"; ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = "rgba(255,255,255,.15)"; ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
            paintBlank();
        }
        mountPleaHubOnProfile();
        setupBioEditor();
        load().catch(err => {
            setMsg(msgAccount, "Failed to load profile.");
            console.error("[user.js] init load error", err);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    /* ===== helpers kept near bottom ===== */
    function extractSlugFromPath(path) {
        const p = path.replace(/\/+$/, "");
        const m = p.match(/^\/user\/([^\/?#]+)(?:\/edit)?(?:[\/?#]|$)/i);
        if (m) return decodeURIComponent(m[1]);
        const parts = p.split("/").filter(Boolean);
        const i = parts.indexOf("user");
        if (i !== -1 && parts[i + 1]) return decodeURIComponent(parts[i + 1]);
        return "";
    }

})();
