/**
 * Short-code generation for local mode.
 *
 * Auto-generated codes use a deliberately reduced alphabet (no 0/o/1/l/i) so
 * they survive being read aloud or retyped. User-chosen aliases get a wider,
 * URL-safe charset because the human picked them on purpose.
 */

import { customAlphabet } from 'nanoid';
import { CODE_ALPHABET } from './constants.js';

/** Thrown when a unique code cannot be generated after exhausting attempts. */
export class CodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodeError';
  }
}

// One generator per length is cheap to build and lets nanoid cache its work.
const generators = new Map();
function generatorFor(length) {
  let gen = generators.get(length);
  if (!gen) {
    gen = customAlphabet(CODE_ALPHABET, length);
    generators.set(length, gen);
  }
  return gen;
}

/**
 * Generate a random short code.
 * @param {number} [length=7]
 * @returns {string}
 */
export function generateCode(length = 7) {
  return generatorFor(length)();
}

// Path segments the local server owns and that must not be claimed as aliases.
const RESERVED = new Set(['', 'healthz', 'favicon.ico', 'robots.txt']);
const ALIAS_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate a user-supplied alias: URL-path-safe, 1–64 chars, not reserved.
 * @param {string} alias
 * @returns {boolean}
 */
export function isValidAlias(alias) {
  if (typeof alias !== 'string') return false;
  if (RESERVED.has(alias.toLowerCase())) return false;
  return ALIAS_RE.test(alias);
}

/**
 * Generate a code guaranteed (per `exists`) to be free.
 * Retries `maxAttempts` times at each length, then bumps the length by 1, up to
 * `maxLength`. With a 32-char alphabet at length 7 this effectively never loops,
 * but the bump keeps us correct under pathological saturation.
 *
 * @param {object} opts
 * @param {number} [opts.length=7] starting length
 * @param {(code: string) => boolean} opts.exists predicate: is this code taken?
 * @param {number} [opts.maxAttempts=5] tries per length before bumping
 * @param {number} [opts.maxLength=16] largest length to try
 * @returns {string}
 * @throws {CodeError}
 */
export function generateUniqueCode({ length = 7, exists, maxAttempts = 5, maxLength = 16 }) {
  if (typeof exists !== 'function') {
    throw new CodeError('generateUniqueCode requires an exists() predicate');
  }
  for (let len = length; len <= maxLength; len++) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = generateCode(len);
      if (!exists(code)) return code;
    }
  }
  throw new CodeError(
    `could not generate a unique short code after exhausting lengths ${length}–${maxLength}`,
  );
}
