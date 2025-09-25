// server/dev-mailbox.js
const outbox = [];

function send(type, to, subject, body) {
    const item = {
        id: outbox.length + 1,
        type, to, subject, body,
        ts: new Date().toISOString(),
    };
    outbox.push(item);
    if (process.env.DEV_MAILBOX === '1') {
        console.log(`[DEV MAIL] to: ${to}  subj: ${subject}\n${body}\n`);
    }
    return item;
}

function list() { return outbox.slice(); }
function clear() { outbox.length = 0; }

module.exports = { send, list, clear, outbox };
