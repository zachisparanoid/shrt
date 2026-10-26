/**
 * All terminal presentation: color decisions, the three output modes
 * (human / quiet / json), the history table, relative times, the spinner,
 * and QR rendering.
 *
 * Formatting functions are pure (return strings) so they're easy to test; the
 * command layer decides which stream to write them to.
 */

import { createColors } from 'picocolors';
import Table from 'cli-table3';
import qrcode from 'qrcode-terminal';

/**
 * Decide whether to emit ANSI color.
 * Precedence: --no-color / NO_COLOR (off) > FORCE_COLOR (on) > mode > TTY.
 * @param {{ mode?: 'auto'|'always'|'never', noColor?: boolean, isTTY?: boolean, env?: NodeJS.ProcessEnv }} opts
 * @returns {boolean}
 */
export function shouldColor({ mode = 'auto', noColor = false, isTTY = false, env = process.env } = {}) {
  if (noColor) return false;
  if (env.NO_COLOR !== undefined) return false; // NO_COLOR: present (any value) disables
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return Boolean(isTTY);
}

/** @param {boolean} enabled @returns {import('picocolors').Colors} */
export function makeColors(enabled) {
  return createColors(enabled);
}

/** A no-op colors object (identity functions) for when color is disabled. */
const PLAIN = new Proxy({}, { get: () => (s) => String(s) });

/** Map internal results to the stable JSON output shape. */
export function toJsonResults(results) {
  return results.map((r) => ({
    input: r.input,
    shortUrl: r.ok ? r.shortUrl : null,
    code: r.code ?? null,
    mode: r.mode ?? null,
    provider: r.provider ?? null,
    ms: r.ms ?? null,
    deduped: Boolean(r.deduped),
    error: r.ok ? null : (r.error ?? 'failed'),
    meta: {
      custom: Boolean(r.custom),
      warnings: r.warnings ?? [],
      ...(r.attempts ? { attempts: r.attempts } : {}),
    },
  }));
}

/** Pretty JSON array of results. */
export function formatJson(results) {
  return JSON.stringify(toJsonResults(results), null, 2);
}

/** Only the successful short URLs, newline-separated. Pipe-safe. */
export function formatQuiet(results) {
  return results
    .filter((r) => r.ok)
    .map((r) => r.shortUrl)
    .join('\n');
}

/**
 * Human, colorized output: one block per URL plus an optional summary footer.
 * @param {object[]} results
 * @param {{ colors?: any, verbose?: boolean, showFooter?: boolean }} opts
 */
export function formatHuman(results, { colors, verbose = false, showFooter = true } = {}) {
  const c = colors || PLAIN;
  const blocks = [];

  for (const r of results) {
    const lines = [];
    if (r.ok) {
      const meta = [r.mode, r.provider, r.ms != null ? `${r.ms}ms` : null, r.deduped ? 'deduped' : null]
        .filter(Boolean)
        .join(' · ');
      lines.push(`${c.green('✓')} ${c.bold(c.cyan(r.shortUrl))}   ${c.dim(c.magenta(`(${meta})`))}`);
      lines.push(`  ${c.dim('↳ ' + r.longUrl)}`);
      for (const w of r.warnings ?? []) lines.push(`  ${c.yellow('!')} ${c.yellow(w)}`);
      if (verbose && r.note) lines.push(`  ${c.dim('· ' + r.note)}`);
    } else {
      lines.push(`${c.red('✗')} ${c.red(r.error ?? 'failed')}`);
      if (verbose && r.attempts) {
        for (const a of r.attempts) {
          lines.push(`  ${c.dim(`· ${a.provider}: ${a.ok ? 'ok' : a.error} (${a.ms}ms)`)}`);
        }
      }
    }
    blocks.push(lines.join('\n'));
  }

  let out = blocks.join('\n\n');

  if (showFooter && results.length > 1) {
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    const deduped = results.filter((r) => r.ok && r.deduped).length;
    const parts = [`${ok} shortened`, `${failed} failed`];
    if (deduped) parts.push(`${deduped} deduped`);
    const footer = parts.join(', ');
    out += `\n\n${failed ? c.yellow(footer) : c.green(footer)}`;
  }

  return out;
}

/** Truncate a string to `len` chars, replacing the tail with an ellipsis. */
export function truncate(str, len) {
  const s = String(str ?? '');
  if (s.length <= len) return s;
  if (len <= 1) return '…';
  return s.slice(0, len - 1) + '…';
}

/** Human-friendly relative time, e.g. "3m ago". @param {string|null} iso @param {number} nowMs */
export function formatRelative(iso, nowMs = Date.now()) {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const sec = Math.round((nowMs - then) / 1000);
  if (sec < 0) return 'in the future';
  if (sec < 15) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Render the history table for `list`.
 * @param {object[]} rows db rows
 * @param {{ colors?: any, nowMs?: number, termWidth?: number }} opts
 * @returns {string}
 */
export function formatListTable(rows, { colors, nowMs = Date.now(), termWidth = 80 } = {}) {
  const c = colors || PLAIN;
  // Reserve width for the fixed columns; give the rest to long_url.
  const longWidth = Math.max(20, Math.min(60, termWidth - 56));
  const table = new Table({
    head: ['when', 'short', 'long', 'mode', 'hits', 'tags'].map((h) => c.bold(c.underline(h))),
    style: { head: [], border: [] },
    wordWrap: false,
  });
  for (const r of rows) {
    table.push([
      formatRelative(r.created_at, nowMs),
      c.cyan(r.code ? r.code : truncate(r.short_url, 28)),
      truncate(r.long_url, longWidth),
      `${r.mode}${r.provider && r.provider !== 'local' ? `/${r.provider}` : ''}`,
      String(r.hits ?? 0),
      r.tags || '',
    ]);
  }
  return table.toString();
}

/** Render an ASCII QR code for a string. @returns {Promise<string>} */
export function renderQr(text) {
  return new Promise((resolve) => {
    qrcode.generate(text, { small: true }, (qr) => resolve(qr));
  });
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Minimal stderr spinner. Inert unless enabled (TTY, not quiet/json).
 * @param {{ stream?: NodeJS.WriteStream, enabled?: boolean }} [opts]
 */
export function createSpinner({ stream = process.stderr, enabled = false } = {}) {
  let timer = null;
  let frame = 0;
  let label = '';

  function paint() {
    stream.write(`\r${SPINNER_FRAMES[frame]} ${label}\x1b[K`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  }
  return {
    start(text = '') {
      if (!enabled) return;
      label = text;
      paint();
      timer = setInterval(paint, 80);
      if (timer.unref) timer.unref();
    },
    update(text) {
      label = text;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (enabled) stream.write('\r\x1b[K'); // clear the line
    },
  };
}
