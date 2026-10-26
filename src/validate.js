/**
 * URL cleaning, normalization, and the SSRF safety guard.
 *
 * All URL parsing goes through the WHATWG `URL` API — we never hand-roll it.
 * The guard exists because a shortener that submits/resolves arbitrary URLs is
 * a textbook SSRF vector (e.g. cloud metadata at 169.254.169.254).
 */

import { KNOWN_SHORTENER_HOSTS, ALREADY_SHORT_LEN } from './constants.js';

/** Error thrown for any invalid or disallowed URL. */
export class ValidationError extends Error {
  /**
   * @param {string} message human-readable reason
   * @param {{ code?: string, input?: string }} [opts]
   */
  constructor(message, { code = 'invalid', input } = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = code; // 'invalid' | 'scheme' | 'private' | 'empty'
    this.input = input;
  }
}

/**
 * Trim whitespace and strip one layer of surrounding quotes / angle brackets,
 * which commonly survive copy-paste and shell piping.
 * @param {string} raw
 * @returns {string}
 */
export function cleanInput(raw) {
  let s = String(raw ?? '').trim();
  // Strip matching surrounding wrappers, repeatedly (e.g. "<...>").
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['<', '>'],
  ];
  let changed = true;
  while (changed && s.length >= 2) {
    changed = false;
    for (const [open, close] of pairs) {
      if (s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(1, -1).trim();
        changed = true;
      }
    }
  }
  return s;
}

// Schemes we explicitly recognise so they are rejected (not https-prepended).
const NON_HTTP_SCHEME_RE = /^(mailto|tel|sms|javascript|data|file|ftp|ftps|ws|wss|blob|about|chrome):/i;
const HTTP_SCHEME_RE = /^https?:\/\//i;

/**
 * Clean the input, detect/repair the scheme, and parse it.
 * Adds `https://` only when there is genuinely no scheme present.
 * @param {string} rawInput
 * @returns {{ url: string, host: string, protocol: string, note?: string, cleaned: string }}
 * @throws {ValidationError} when the input cannot be parsed as a URL at all
 */
export function normalizeUrl(rawInput) {
  const cleaned = cleanInput(rawInput);
  if (!cleaned) {
    throw new ValidationError('empty URL', { code: 'empty', input: rawInput });
  }

  let candidate = cleaned;
  let note;
  const hasHttp = HTTP_SCHEME_RE.test(cleaned);
  const hasOtherScheme = NON_HTTP_SCHEME_RE.test(cleaned);
  if (!hasHttp && !hasOtherScheme) {
    candidate = `https://${cleaned}`;
    note = 'added https:// scheme';
  }

  let urlObj;
  try {
    urlObj = new URL(candidate);
  } catch {
    throw new ValidationError(`invalid URL: ${cleaned}`, { code: 'invalid', input: rawInput });
  }

  return {
    url: urlObj.href,
    host: urlObj.hostname,
    protocol: urlObj.protocol,
    note,
    cleaned,
  };
}

/** @param {string} host @returns {boolean} */
function isIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

/** Strip brackets and zone id from an IPv6 hostname. @param {string} host */
function bareIpv6(host) {
  return host.replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');
}

/** @param {string} host @returns {boolean} */
function isIpv6(host) {
  const h = bareIpv6(host);
  return h.includes(':') && /^[0-9a-f:]+$/i.test(h);
}

/**
 * True for loopback, RFC1918 private, CGNAT, link-local, and *.local / *.localhost hosts.
 * @param {string} rawHost
 * @returns {boolean}
 */
export function isPrivateHost(rawHost) {
  if (!rawHost) return true;
  const host = rawHost.toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local')) return true;

  if (isIpv6(host)) {
    const h = bareIpv6(host);
    if (h === '::1' || h === '::') return true;
    // Unique-local fc00::/7 and link-local fe80::/10, plus IPv4-mapped loopback.
    if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(h)) return true;
    if (/^::ffff:127\./i.test(h)) return true;
    return false;
  }

  if (isIpv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
    if (a === 0) return true; // 0.0.0.0/8 "this" network
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }

  return false;
}

/** Does the host look like a routable FQDN or IP (has a dot, or is an IP)? */
function isAddressable(host) {
  return isIpv4(host) || isIpv6(host) || (host.includes('.') && !host.endsWith('.'));
}

// A plausible hostname: dot-separated labels of letters/digits/hyphen/underscore.
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;

/** True if the host is a syntactically valid hostname or IP. Applies in all modes. */
function isPlausibleHost(host) {
  return isIpv4(host) || isIpv6(host) || HOSTNAME_RE.test(host);
}

/**
 * Full validation pipeline: clean → normalize → enforce http(s) → SSRF guard.
 * @param {string} rawInput
 * @param {{ allowPrivate?: boolean }} [opts]
 * @returns {{ input: string, url: string, host: string, note?: string }}
 * @throws {ValidationError}
 */
export function validateUrl(rawInput, { allowPrivate = false } = {}) {
  const { url, host, protocol, note, cleaned } = normalizeUrl(rawInput);

  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new ValidationError(`invalid URL (unsupported scheme '${protocol}'): ${cleaned}`, {
      code: 'scheme',
      input: rawInput,
    });
  }
  if (!host) {
    throw new ValidationError(`invalid URL (no host): ${cleaned}`, { code: 'invalid', input: rawInput });
  }
  // Reject syntactically impossible hosts (e.g. "ht!tp", "has space") in all modes.
  if (!isPlausibleHost(host)) {
    throw new ValidationError(`invalid URL (bad host '${host}'): ${cleaned}`, { code: 'invalid', input: rawInput });
  }

  if (!allowPrivate) {
    if (isPrivateHost(host)) {
      throw new ValidationError(`blocked private/loopback host: ${host} (use --allow-private to override)`, {
        code: 'private',
        input: rawInput,
      });
    }
    if (!isAddressable(host)) {
      throw new ValidationError(`blocked non-public host: ${host} (use --allow-private to override)`, {
        code: 'private',
        input: rawInput,
      });
    }
  }

  return { input: rawInput, url, host, note };
}

/**
 * Advisory heuristic: is this URL already short, or pointing at a known shortener?
 * @param {string} rawInput
 * @returns {boolean}
 */
export function isAlreadyShort(rawInput) {
  const cleaned = cleanInput(rawInput);
  if (!cleaned) return false;
  if (cleaned.length <= ALREADY_SHORT_LEN) return true;
  try {
    const { host } = normalizeUrl(cleaned);
    return KNOWN_SHORTENER_HOSTS.has(host.toLowerCase());
  } catch {
    return false;
  }
}
