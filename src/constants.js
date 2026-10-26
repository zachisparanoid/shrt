/**
 * Shared constants used across modules.
 * Kept dependency-free so every module can import it cheaply.
 */

/** Built-in remote provider names, in no particular order. */
export const PROVIDER_NAMES = ['is.gd', 'tinyurl', 'cleanuri'];

/**
 * Short-code alphabet for local mode. Deliberately excludes ambiguous
 * characters (0/O, 1/l/I) so codes are easy to read aloud and retype.
 */
export const CODE_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyz';

/**
 * Process exit codes. Loosely follows BSD sysexits(3) so the tool plays
 * nicely in shell pipelines and CI.
 * @see https://man.freebsd.org/cgi/man.cgi?sysexits
 */
export const EXIT = Object.freeze({
  OK: 0, // all URLs succeeded
  FAIL: 1, // total failure (no URL succeeded)
  PARTIAL: 2, // some succeeded, some failed (batch)
  USAGE: 64, // EX_USAGE — bad invocation / empty input
  NOINPUT: 66, // EX_NOINPUT — -f file missing/unreadable
  SOFTWARE: 70, // EX_SOFTWARE — internal/DB error
  TEMPFAIL: 75, // EX_TEMPFAIL — server bind error (EADDRINUSE)
});

/**
 * Hosts/shorteners we recognise as "already short" for the warning heuristic.
 * Not exhaustive — purely advisory.
 */
export const KNOWN_SHORTENER_HOSTS = new Set([
  'is.gd',
  'v.gd',
  'tinyurl.com',
  'cleanuri.com',
  'bit.ly',
  'goo.gl',
  't.co',
  'ow.ly',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  's.id',
]);

/** Length under which an input is considered "already short" (advisory). */
export const ALREADY_SHORT_LEN = 25;
