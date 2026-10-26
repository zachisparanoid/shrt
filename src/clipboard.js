/**
 * Best-effort clipboard copy by spawning a platform tool. Degrades gracefully:
 * if no tool is present, returns { ok: false } rather than throwing.
 */

import { spawn } from 'node:child_process';

/** Tools tried in order (Wayland, X11, then macOS for portability). */
const DEFAULT_CANDIDATES = [
  { cmd: 'wl-copy', args: [] },
  { cmd: 'xclip', args: ['-selection', 'clipboard'] },
  { cmd: 'xsel', args: ['--clipboard', '--input'] },
  { cmd: 'pbcopy', args: [] },
];

/** Spawn one tool and pipe `text` to its stdin. @returns {Promise<void>} */
function spawnCopy(spawnImpl, cmd, args, text) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch (err) {
      reject(err);
      return;
    }
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    try {
      child.stdin.end(text);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Copy text to the clipboard using the first working tool.
 * @param {string} text
 * @param {{ candidates?: Array<{cmd:string,args:string[]}>, spawnImpl?: typeof spawn }} [opts]
 * @returns {Promise<{ ok: boolean, tool?: string }>}
 */
export async function copyToClipboard(text, { candidates = DEFAULT_CANDIDATES, spawnImpl = spawn } = {}) {
  for (const { cmd, args } of candidates) {
    try {
      await spawnCopy(spawnImpl, cmd, args, text);
      return { ok: true, tool: cmd };
    } catch {
      // tool missing or failed — try the next one
    }
  }
  return { ok: false };
}
