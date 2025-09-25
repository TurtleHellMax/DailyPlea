let outbox = [];
function send(kind, to, subject, body) {
    const msg = { ts: new Date().toISOString(), kind, to, subject, body };
    outbox.push(msg);
    console.log('[DEV-MAILBOX]', msg);
}
function list() { return outbox.slice().reverse(); }
module.exports = { send, list };