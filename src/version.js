/** Reads the package version once, from package.json next to the source tree. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {string} */
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();
