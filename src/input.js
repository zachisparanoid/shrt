/**
 * Collect URLs to shorten from the three supported sources — CLI args, a file
 * (`-f`), and piped stdin — then clean and de-duplicate them.
 */

import { readFileSync } from 'node:fs';
import { cleanInput } from './validate.js';

/** Thrown when an input source cannot be read. */
export class InputError extends Error {
  /** @param {string} message @param {{ code?: string, cause?: unknown }} [opts] */
  constructor(message, { code = 'input', cause } = {}) {
    super(message);
    this.name = 'InputError';
    this.code = code; // 'noinput' | 'input'
    this.cause = cause;
  }
}

/**
 * Split text into URL lines: trim each, drop blanks and `#` comments.
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** Read an entire readable stream into a string. @returns {Promise<string>} */
export function readStream(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding?.('utf8');
    stream.on('data', (chunk) => (data += chunk));
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

/**
 * Gather URLs from args + file + stdin (in that priority), cleaned and de-duped.
 * @param {object} opts
 * @param {string[]} [opts.args]
 * @param {string|null} [opts.filePath]
 * @param {NodeJS.ReadableStream|null} [opts.stdin]
 * @param {boolean} [opts.stdinIsTTY] when true, stdin is interactive → ignored
 * @returns {Promise<string[]>}
 */
export async function collectUrls({ args = [], filePath = null, stdin = null, stdinIsTTY = true } = {}) {
  const raw = [];

  for (const a of args) raw.push(a);

  if (filePath) {
    let content;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new InputError(`cannot read input file: ${filePath} (${err.code || err.message})`, {
        code: 'noinput',
        cause: err,
      });
    }
    raw.push(...splitLines(content));
  }

  // Read stdin only when it is the sole source: piped (non-TTY) AND no args/file.
  // This is conventional (like `cat`) and, crucially, avoids blocking forever on
  // an open-but-idle inherited stdin when URLs were already supplied via args.
  if (stdin && !stdinIsTTY && args.length === 0 && !filePath) {
    const text = await readStream(stdin);
    raw.push(...splitLines(text));
  }

  // Clean (trim/strip quotes) and de-duplicate, preserving first occurrence.
  const seen = new Set();
  const urls = [];
  for (const item of raw) {
    const cleaned = cleanInput(item);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return urls;
}
