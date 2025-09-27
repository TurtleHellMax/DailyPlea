const fs = require('fs');
const path = require('path');

let _bannedCache = null;
function getBanned() {
    if (_bannedCache) return _bannedCache;
    const fp = path.join(__dirname, '..', 'banned_usernames.txt');
    try {
        const txt = fs.readFileSync(fp, 'utf8');
        _bannedCache = txt.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean);
    } catch {
        _bannedCache = [];
    }
    return _bannedCache;
}

function isUsernameBanned(u) {
    const lu = String(u || '').toLowerCase();
    const banned = getBanned();
    // reject if the username contains any banned term
    return banned.some(term => lu.includes(term));
}

function isValidUsername(u) {
    const s = String(u || '').trim();
    // allow letters, numbers, underscore, dot; 3..32 chars
    return /^[a-zA-Z0-9_.]{3,32}$/.test(s);
}

function passwordPolicyError(pw) {
    const s = String(pw || '');
    if (s.length <= 6 || s.length >= 32) return 'Password must be 7-31 characters.';
    if (!/[A-Z]/.test(s)) return 'Password must include an uppercase letter.';
    if (!/[0-9]/.test(s)) return 'Password must include a number.';
    if (!/[^a-zA-Z0-9]/.test(s)) return 'Password must include a symbol.';
    return null; // OK
}

module.exports = { isUsernameBanned, isValidUsername, passwordPolicyError };
