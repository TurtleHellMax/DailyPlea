<script>
    <option value="newest">Newest</option>
    <option value="controversial">Controversial</option>
    <option value="popular">Popular</option>
</select>
</div >
<div id="dp-comment-form" style="margin:8px 0;display:none">
<textarea id="dp-comment-text" rows="3" style="width:100%" placeholder="Add a comment..."></textarea>
<button id="dp-comment-post">Post</button>
</div>
<div id="dp-comments-list"></div>
</div > `;


byId('dp-comments-toggle').onclick = () => {
const body = byId('dp-comments-body');
body.style.display = body.style.display==='none' ? 'block' : 'none';
byId('dp-comments-toggle').textContent = body.style.display==='none' ? 'comments ▼' : 'comments ▲';
if (body.style.display==='block') load();
};
byId('dp-sort').onchange = load;
byId('dp-comment-post').onclick = postComment;
}


async function load() {
if (!S.pleaId) return;
const sort = byId('dp-sort').value;
const j = await api(`/ pleas / ${ S.pleaId } /comments?sort=${encodeURIComponent(sort)}`);
const list = byId('dp-comments-list');
list.innerHTML = j.comments.map(renderComment).join('');
list.querySelectorAll('[data-vote]').forEach(btn => btn.onclick = voteComment);
}


async function postComment() {
    const txt = byId('dp-comment-text').value.trim(); if (!txt) return;
    const r = await fetch(`${S.apiBase}/pleas/${S.pleaId}/comments`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': (window.DP && DP.__csrf) || '' }, body: JSON.stringify({ body: txt }) });
    if (r.ok) { byId('dp-comment-text').value = ''; load(); }
    else { alert('Login required and CSRF token. Use overlay to login first.'); }
}


async function voteComment(ev) {
    const el = ev.currentTarget; const id = el.getAttribute('data-id'); const v = el.getAttribute('data-vote');
    const r = await fetch(`${S.apiBase}/comments/${id}/vote`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': (window.DP && DP.__csrf) || '' }, body: JSON.stringify({ vote: v }) });
    if (r.ok) load(); else alert('Login first.');
}


function renderComment(c) {
    return `<div class="dp-comment" style="border-top:1px solid #333;padding:8px 0">
<div style="opacity:.7;font-size:.9em">#${c.id} • ${new Date(c.created_at).toLocaleString()} • score ${c.score}</div>
<div>${c.body}</div>
<div style="display:flex;gap:8px;margin-top:6px;opacity:.9">
<button data-id="${c.id}" data-vote="1">▲ ${c.up}</button>
<button data-id="${c.id}" data-vote="-1">▼ ${c.down}</button>
</div>
</div>`;
}


function byId(id) { return document.getElementById(id); }


window.DP = window.DP || {};
window.DP.init = (opts) => { S.apiBase = opts.apiBase || S.apiBase; mount(); };
window.DP.onPleaFullyRevealed = (pleaId) => { S.unlocked = true; S.pleaId = pleaId; byId('dp-comment-form').style.display = 'block'; };


// CSRF fetch for comment posts via overlay
fetch('http://localhost:3000/api/csrf', { credentials: 'include' }).then(r => r.json()).then(j => { if (window.DP) DP.__csrf = j.token; });
}) ();
</script >