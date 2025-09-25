const argon2 = require('argon2');
const crypto = require('crypto');
const { z } = require('zod');


const cfg = {
    pepper: process.env.PASSWORD_PEPPER || 'devpepper',
    argon: {
        memoryCost: +(process.env.ARGON2_MEMORY_COST || 19456),
        timeCost: +(process.env.ARGON2_TIME_COST || 2),
        parallelism: +(process.env.ARGON2_PARALLELISM || 1),
        type: argon2.argon2id,
    },
};


async function hashPassword(pw) {
    return argon2.hash(pw + cfg.pepper, cfg.argon);
}
async function verifyPassword(hash, pw) {
    return argon2.verify(hash, pw + cfg.pepper);
}


function newId(bytes = 32) { return crypto.randomBytes(bytes).toString('hex'); }


// CSRF: double-submit token pattern
function issueCsrfToken() { return newId(16); }


// Simple AES-GCM for TOTP secret at rest
const encKey = Buffer.from(process.env.TOTP_ENC_KEY_BASE64 || '', 'base64');
function aesEncrypt(plaintext) {
    if (!encKey || encKey.length !== 32) throw new Error('Bad TOTP_ENC_KEY_BASE64');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}
function aesDecrypt(b64) {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12); const tag = buf.subarray(12, 28); const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
}


const validators = {
    email: z.string().email().max(254),
    phone: z.string().regex(/^\+?[0-9]{7,15}$/),
    password: z.string().min(8).max(200),
    pleaId: z.number().int().nonnegative(),
    commentBody: z.string().min(1).max(4000),
    vote: z.enum(['-1', '0', '1']),
};


module.exports = { hashPassword, verifyPassword, newId, issueCsrfToken, aesEncrypt, aesDecrypt, validators };