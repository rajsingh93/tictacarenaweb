'use strict';

const crypto = require('crypto');
const env = require('../config/env');

/**
 * Authenticator secrets must never be readable from a database dump. They are
 * encrypted with AES-256-GCM using a key derived from the server's JWT secret.
 * Rotating JWT_SECRET intentionally invalidates enrolled authenticators, so the
 * value is documented as a long-lived deployment secret.
 */
const KEY = crypto.createHash('sha256').update(`${env.jwtSecret}:admin-totp:v1`).digest();
const PREFIX = 'enc:v1:';

function encrypt(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decrypt(payload) {
  if (!payload) return null;
  if (!String(payload).startsWith(PREFIX)) return String(payload);
  try {
    const [ivPart, tagPart, dataPart] = String(payload).slice(PREFIX.length).split('.');
    if (!ivPart || !tagPart || !dataPart) return null;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      KEY,
      Buffer.from(ivPart, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    return null;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { encrypt, decrypt, sha256, safeEqual };
