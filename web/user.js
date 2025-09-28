// web/user.js
console.log("[user.js] loaded");

(() => {
    "use strict";

    const API_BASE = "http://localhost:3000/api";
    const MAX_BYTES = 1 * 1024 * 1024;            // 1 MB final cap
    const PNG_MIME = "image/png";
    const ZOOM_MIN_REL = 0.5;                      // for normalized 0..1 slider
    const ZOOM_MAX_REL = 14.0;

    const $id = (id) => document.getElementById(id);
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

    const state = {
        csrf: null,
        slug: null,
        profile: null,   // from /users/by-first
        me: null,        // from /auth/me
        original: {},

        // editor
        img: null,
        zoom: 1,         // relative zoom (1 = fit)
        rot: 0,          // degrees
        panX: 0, panY: 0,
        dragging: false,
        dragStart: { x: 0, y: 0 },
        panStart: { x: 0, y: 0 },

        photoDataUrl: null, // prepared PNG to send
    };

    /* ============ CSRF + API ============ */
    async function fetchCsrf() {
        const r = await fetch(API_BASE.replace("/api", "") + "/api/csrf", { credentials: "include" });
        const j = await r.json().catch(() => ({}));
        const tok = j?.token ?? j?.csrfToken ?? j?.csrf ?? null;
        if (!r.ok || !tok) throw new Error("csrf");
        state.csrf = tok;
        return tok;
    }
    // replace your current api() with this
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
    function fmtDate(s) {
        try { return new Date(s).toLocaleDateString(); } catch { return s || "—"; }
    }

    /* ============ Zoom mapping (for normalized 0..1 slider) ============ */
    // t ∈ [0,1] → rel:
    //   0   → 0.5×
    //   0.5 → 1×
    //   1   → 14×
    function relFromNormalizedSlider(t) {
        t = clamp(Number(t), 0, 1);
        if (t <= 0.5) {
            const u = t / 0.5;                         // 0..1
            return ZOOM_MIN_REL * Math.pow(1 / ZOOM_MIN_REL, u); // 0.5 → 1
        } else {
            const u = (t - 0.5) / 0.5;                 // 0..1
            return Math.pow(ZOOM_MAX_REL, u);          // 1 → 14
        }
    }

    /* ============ Photo editor ============ */
    const canvas = $id("stage");
    const ctx = canvas.getContext("2d");
    const zoomCtl = $id("ctl-zoom");
    const rotCtl = $id("ctl-rot");
    const drop = $id("drop");
    const msgPhoto = $id("msg-photo");

    function drawEditor() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!state.img) return;

        const cw = canvas.width, ch = canvas.height;
        ctx.save();
        ctx.translate(cw / 2 + state.panX, ch / 2 + state.panY);
        ctx.rotate(state.rot * Math.PI / 180);

        // "fit" the image, then apply relative zoom
        const baseScale = Math.min(cw / state.img.width, ch / state.img.height);
        const s = baseScale * state.zoom;
        ctx.scale(s, s);
        ctx.drawImage(state.img, -state.img.width / 2, -state.img.height / 2);
        ctx.restore();

        // crop frame
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,.18)";
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, cw - 2, ch - 2);
        ctx.restore();
    }

    function resetEditor() {
        state.img = null;
        state.zoom = 1;
        state.rot = 0;
        state.panX = 0; state.panY = 0;

        // keep slider in a sensible default for both schemes
        if (zoomCtl) {
            if (zoomCtl.min === "0" && zoomCtl.max === "1") {
                zoomCtl.value = "0.5";   // midpoint = 1×
            } else {
                zoomCtl.value = "1.0";   // direct scheme
            }
        }
        if (rotCtl) rotCtl.value = "0";
        ctx.clearRect(0, 0, canvas.width, canvas.height);
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
            if (zoomCtl) {
                if (zoomCtl.min === "0" && zoomCtl.max === "1") zoomCtl.value = "0.5";
                else zoomCtl.value = "1.0";
            }
            if (rotCtl) rotCtl.value = "0";
            drawEditor();
            console.log("[user.js] image loaded", img.naturalWidth, "x", img.naturalHeight);
        };
        img.onerror = () => setMsg(msgPhoto, "Could not load image");
        img.src = url;
    }

    function isOwner(profile, me, slug) {
        if (!me) return false;

        // 1) Same numeric id? (fast path)
        const pid = Number(profile?.id);
        const mid = Number(me?.id);
        if (Number.isFinite(pid) && Number.isFinite(mid) && pid === mid) return true;

        // 2) If profile couldn't be fetched yet, treat as owner if slug matches me
        const s = String(slug || '').toLowerCase();
        const u1 = String(me.username || '').toLowerCase();
        const u0 = String(me.first_username || '').toLowerCase();
        if (s && (s === u1 || s === u0)) return true;

        return false;
    }

    // Pull a user object out of whatever shape the server returns
    function pickUser(payload) {
        if (!payload) return null;
        if (payload.user && typeof payload.user === 'object') return payload.user;
        if (payload.ok && payload.user) return payload.user;
        if (Array.isArray(payload) && payload.length && typeof payload[0] === 'object') return payload[0];
        if (typeof payload === 'object' && ('id' in payload || 'username' in payload || 'first_username' in payload)) return payload;
        if (payload.items && Array.isArray(payload.items) && payload.items[0] && typeof payload.items[0] === 'object') return payload.items[0];
        return null;
    }

    // Try multiple endpoints/shapes for old/new servers
    async function fetchProfileBySlug(slug) {
        const tries = [
            `/users/by-first/${encodeURIComponent(slug)}`,
            `/users/by_username/${encodeURIComponent(slug)}`,
            `/users/resolve?username=${encodeURIComponent(slug)}`,
            `/users/${encodeURIComponent(slug)}`,           // some servers accept id/slug here
            `/users?first_username=${encodeURIComponent(slug)}` // very old list-style APIs
        ];
        for (const path of tries) {
            try {
                const j = await api(path);
                const u = pickUser(j);
                if (u) return u;
            } catch (e) {
                // keep trying next endpoint
            }
        }
        return null;
    }

    // pan with mouse
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

    // zoom slider supports BOTH styles
    if (zoomCtl) {
        zoomCtl.addEventListener("input", () => {
            if (zoomCtl.min === "0" && zoomCtl.max === "1") {
                const rel = relFromNormalizedSlider(zoomCtl.value);
                state.zoom = rel;
                console.log(`[user.js] zoom(normalized) t=${(+zoomCtl.value).toFixed(2)} → ${rel.toFixed(3)}×`);
            } else {
                const raw = parseFloat(zoomCtl.value) || 1;
                state.zoom = raw;
                console.log(`[user.js] zoom(raw) value=${raw.toFixed(3)}×`);
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

    // file & DnD
    const fileInput = $id("file");
    if (fileInput) {
        fileInput.addEventListener("change", (ev) => {
            const f = ev.target.files && ev.target.files[0];
            setImageFromFile(f);
        });
    }
    ["dragenter", "dragover", "dragleave", "drop"].forEach(evt => {
        drop.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
    });
    drop.addEventListener("drop", (e) => {
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        setImageFromFile(f);
    });

    $id("btn-reset").addEventListener("click", resetEditor);

    $id("btn-apply").addEventListener("click", async () => {
        if (!state.img) { setMsg(msgPhoto, "Choose an image first."); return; }

        // Render a 512×512 PNG from current view (square crop)
        const size = 512;
        const out = document.createElement("canvas");
        out.width = size; out.height = size;
        const ox = out.getContext("2d");
        ox.clearRect(0, 0, size, size);

        // same transform scaled into 512 space
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
        console.log("[user.js] PNG size", blob.size, "bytes");
        if (blob.size > MAX_BYTES) {
            setMsg(msgPhoto, "Processed image is too large (> 1 MB). Please crop/zoom more or choose a smaller image.");
            return;
        }

        // dataURL for preview + upload body
        const dataUrl = await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.readAsDataURL(blob);
        });
        state.photoDataUrl = dataUrl;
        setAvatar(dataUrl);
        setMsg(msgPhoto, "Photo ready. Click “Save changes” to upload.", true);
    });

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
        return hasPlus ? "+" + s.replace(/[+]/g, "") : s.replace(/[+]/g, "");
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

    fNew.addEventListener("input", () => {
        const on = fNew.value.length > 0;
        pwExtra.style.display = on ? "" : "none";
        if (!on) { fConfirm.value = ""; fCurrent.value = ""; }
    });

    $id("btn-cancel").addEventListener("click", () => {
        fUsername.value = state.original.username || "";
        fEmail.value = state.original.email || "";
        fPhone.value = state.original.phone || "";
        setAvatar(state.original.photo || "");
        fNew.value = ""; fConfirm.value = ""; fCurrent.value = "";
        pwExtra.style.display = "none";
        state.photoDataUrl = null;
        setMsg(msgAccount, "");
        setMsg(msgPhoto, "");
        resetEditor();
    });

    $id("btn-save").addEventListener("click", async () => {
        setMsg(msgAccount, "");

        if (!isOwner(state.profile, state.me, state.slug)) {
            setMsg(msgAccount, "You must be the owner to edit this profile.");
            return;
        }

        const username = fUsername.value.trim();
        const email = sanitizeEmail(fEmail.value);
        const phone = sanitizePhone(fPhone.value);
        const newpw = fNew.value;
        const confirm = fConfirm.value;
        const current = fCurrent.value;

        if (username && !USERNAME_RE.test(username)) { setMsg(msgAccount, "Username must be 3–24: letters, numbers, underscore."); return; }
        if (email && !isEmail(email)) { setMsg(msgAccount, "Invalid email."); return; }
        if (phone && !isPhone(phone)) { setMsg(msgAccount, "Invalid phone."); return; }

        const body = {};

        // Username
        if (username && username !== state.original.username) {
            body.username = username;
        }

        // Only update contact fields if the input is enabled AND non-empty.
        // (Prevents accidental NULL’ing when fields are blank/disabled.)
        const emailEnabled = !fEmail.disabled;
        const phoneEnabled = !fPhone.disabled;

        if (emailEnabled && email && email !== state.original.email) {
            body.email = email;
        }
        if (phoneEnabled && phone && phone !== state.original.phone) {
            body.phone = phone;
        }

        // Photo
        if (state.photoDataUrl) body.profile_photo = state.photoDataUrl;

        // Password
        if (newpw.length > 0) {
            if (!strongPassword(newpw)) { setMsg(msgAccount, "Password must be 7–31 chars and include a capital, a number, and a symbol."); return; }
            if (newpw !== confirm) { setMsg(msgAccount, "Password confirmation does not match."); return; }
            body.password = newpw;
            body.current_password = current || "";
        }

        if (Object.keys(body).length === 0) {
            setMsg(msgAccount, "No changes to save.", false); return;
        }

        try {
            await fetchCsrf();
            const res = await api("/users/by-first/" + encodeURIComponent(state.slug), {
                method: "PATCH",
                body: JSON.stringify(body)
            });

            const updated = res.user || {};
            // Merge updated user into local state so header/me stay in sync
            if (state.me && updated.id === state.me.id) state.me = { ...state.me, ...updated };
            if (state.profile && updated.id === state.profile.id) state.profile = { ...state.profile, ...updated };

            // Update UI header name if username changed
            $id("hdr-username").textContent =
                (isOwner(state.profile, state.me, state.slug) && state.me?.username)
                    ? state.me.username
                    : (state.profile.username || state.profile.first_username || state.slug);

            if ("profile_photo" in body) {
                setAvatar(state.photoDataUrl);
            }

            // Update originals only for fields we actually sent
            if ("username" in body) state.original.username = updated.username || state.original.username;
            if ("email" in body) state.original.email = updated.email || "";
            if ("phone" in body) state.original.phone = updated.phone || "";
            if ("profile_photo" in body) state.original.photo = state.photoDataUrl;

            fNew.value = ""; fConfirm.value = ""; fCurrent.value = "";
            pwExtra.style.display = "none";
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

    function mountPleaHubOnProfile() {
        // avoid duplicates
        if (document.querySelector('.plea-hub-btn')) return;

        const a = document.createElement('a');
        a.href = '/pleas/';
        a.className = 'plea-hub-btn';
        a.setAttribute('aria-label', 'Open Plea Select');

        const img = new Image();
        img.src = '/icons/plea-hub.png';   // change path if your icon lives elsewhere
        img.alt = 'Plea Select';
        img.decoding = 'async';
        img.loading = 'eager';
        img.draggable = false;
        a.appendChild(img);

        // remember where we came from (optional)
        a.addEventListener('click', () => {
            try { sessionStorage.setItem('plea:return', 'profile'); } catch { }
        }, { capture: true });

        document.body.appendChild(a);
        // fade in using your .is-show rule
        requestAnimationFrame(() => a.classList.add('is-show'));
    }

    // after: const canvas = $('stage'), ctx = canvas.getContext('2d');
    function paintBlank() {
        // reset any transforms, clear, then fill black
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // in resetEditor(), replace the clear with paintBlank():
    function resetEditor() {
        state.img = null; state.zoom = 1; state.rot = 0; state.panX = 0; state.panY = 0;

        if (zoomCtl) {
            if (zoomCtl.min === "0" && zoomCtl.max === "1") {
                zoomCtl.value = "0.5"; // midpoint = 1× for normalized slider
            } else {
                zoomCtl.value = "1.0"; // direct-zoom sliders
            }
        }
        if (rotCtl) rotCtl.value = "0";

        paintBlank();
        setMsg(msgPhoto, "");
    }

    /* ============ Load profile + me, fill header/form ============ */
    async function load() {
        // slug from /user/:slug
        const parts = location.pathname.split("/").filter(Boolean);
        state.slug = decodeURIComponent(parts[parts.length - 1] || "");
        $id("hdr-slug").textContent = state.slug;
        console.log("[user.js] loading profile for slug:", state.slug);

        // fetch in parallel
        const [profileUser, meRaw] = await Promise.all([
            fetchProfileBySlug(state.slug),
            api("/auth/me").catch(() => null)
        ]);

        state.me = meRaw ? (meRaw.user || meRaw) : null;

        // If server didn't return a profile, but you ARE the owner by slug, use `me` as the profile.
        state.profile = profileUser || (isOwner(null, state.me, state.slug) ? state.me : null);

        if (!state.profile) {
            setMsg(msgAccount, "Profile not found", false);
            console.error("[user.js] profile load failed (no user for slug)");
            return;
        }

        const owner = isOwner(state.profile, state.me, state.slug);
        console.log("[user.js] ids", { profileId: state.profile?.id, meId: state.me?.id, owner });

        // Header
        const headerName = (owner && state.me?.username)
            ? state.me.username
            : (state.profile.username || state.profile.first_username || state.slug);

        $id("hdr-username").textContent = headerName;
        $id("hdr-joined").textContent = fmtDate(state.profile.created_at);
        setAvatar(state.profile.profile_photo || "");

        // Form initial values
        fUsername.value = state.profile.username || (owner ? (state.me.username || "") : "");

        if (owner) {
            fEmail.value = state.me.email || "";
            fPhone.value = state.me.phone || "";
            fEmail.disabled = false;
            fPhone.disabled = false;
            $id("f-newpw").disabled = false;
            setMsg(msgAccount, "");
        } else {
            fEmail.value = "";
            fPhone.value = "";
            fEmail.disabled = true;
            fPhone.disabled = true;
            $id("f-newpw").disabled = true;
            setMsg(msgAccount, "Viewing public profile (read-only). Login as this user to edit.", false);
        }

        state.original = {
            username: fUsername.value,
            email: fEmail.value,
            phone: fPhone.value,
            photo: state.profile.profile_photo || null
        };
    }

    /* ============ Kick off ============ */
    function init() {
        console.log("[user.js] DOM ready");
        // Draw a blank stage so canvas isn't visually empty
        ctx.fillStyle = "#111827"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = "rgba(255,255,255,.15)"; ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
        paintBlank();
        mountPleaHubOnProfile();

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
})();
