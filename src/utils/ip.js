'use strict';

const net = require('net');

function normalizeIp(value) {
  let ip = String(value || '').trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  if (ip.includes(',') ) ip = ip.split(',')[0].trim();
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  return ip;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const number = Number(part);
    if (number > 255) return null;
    value = (value << 8) + number;
  }
  return value >>> 0;
}

function ipv6ToBigInt(ip) {
  if (!net.isIPv6(ip)) return null;
  let value = ip;
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const v4 = ipv4ToInt(value.slice(lastColon + 1));
    if (v4 === null) return null;
    value =
      value.slice(0, lastColon + 1) +
      ((v4 >>> 16) & 0xffff).toString(16) +
      ':' +
      (v4 & 0xffff).toString(16);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    result = (result << 16n) + BigInt(parseInt(group, 16));
  }
  return result;
}

function matchesCidr(ip, rule) {
  const [network, bitsRaw] = String(rule).split('/');
  const bits = Number(bitsRaw);
  if (!network || !Number.isInteger(bits)) return false;

  if (net.isIPv4(ip) && net.isIPv4(network)) {
    if (bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    const a = ipv4ToInt(ip);
    const b = ipv4ToInt(network);
    return a !== null && b !== null && (a & mask) === (b & mask);
  }

  if (net.isIPv6(ip) && net.isIPv6(network)) {
    if (bits < 0 || bits > 128) return false;
    const a = ipv6ToBigInt(ip);
    const b = ipv6ToBigInt(network);
    if (a === null || b === null) return false;
    if (bits === 0) return true;
    const shift = BigInt(128 - bits);
    return (a >> shift) === (b >> shift);
  }

  return false;
}

function ipMatchesAllowlist(ip, allowlist) {
  const rules = (Array.isArray(allowlist) ? allowlist : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  if (!rules.length) return true;
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  return rules.some((rule) =>
    rule.includes('/')
      ? matchesCidr(normalized, rule)
      : normalizeIp(rule) === normalized
  );
}

function validateAllowlistEntry(entry) {
  const value = String(entry || '').trim();
  if (!value) return false;
  if (value.includes('/')) {
    const [network, bits] = value.split('/');
    if (!Number.isInteger(Number(bits))) return false;
    if (net.isIPv4(network)) return Number(bits) >= 0 && Number(bits) <= 32;
    if (net.isIPv6(network)) return Number(bits) >= 0 && Number(bits) <= 128;
    return false;
  }
  return net.isIP(value) !== 0;
}

module.exports = { normalizeIp, ipMatchesAllowlist, validateAllowlistEntry, matchesCidr };
