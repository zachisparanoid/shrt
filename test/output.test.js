import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldColor,
  toJsonResults,
  formatJson,
  formatQuiet,
  formatHuman,
  formatRelative,
  truncate,
} from '../src/output.js';

const okRemote = {
  input: 'https://example.com/long',
  ok: true,
  shortUrl: 'https://is.gd/Ab3xYz',
  code: null,
  longUrl: 'https://example.com/long',
  mode: 'remote',
  provider: 'is.gd',
  ms: 142,
  deduped: false,
  warnings: [],
};
const okLocal = {
  input: 'https://example.com/p',
  ok: true,
  shortUrl: 'http://localhost:8787/ab3xyz',
  code: 'ab3xyz',
  longUrl: 'https://example.com/p',
  mode: 'local',
  provider: 'local',
  deduped: true,
  warnings: [],
};
const failed = { input: 'ftp://nope', ok: false, error: 'invalid URL (unsupported scheme): ftp://nope', errorCode: 'scheme', warnings: [] };

test('shouldColor: NO_COLOR disables regardless of mode', () => {
  assert.equal(shouldColor({ mode: 'always', env: { NO_COLOR: '1' }, isTTY: true }), false);
  assert.equal(shouldColor({ mode: 'always', env: { NO_COLOR: '' }, isTTY: true }), false); // present even if empty
});

test('shouldColor: --no-color flag disables', () => {
  assert.equal(shouldColor({ mode: 'auto', noColor: true, isTTY: true, env: {} }), false);
});

test('shouldColor: auto follows TTY', () => {
  assert.equal(shouldColor({ mode: 'auto', isTTY: true, env: {} }), true);
  assert.equal(shouldColor({ mode: 'auto', isTTY: false, env: {} }), false);
});

test('shouldColor: always/never override TTY', () => {
  assert.equal(shouldColor({ mode: 'always', isTTY: false, env: {} }), true);
  assert.equal(shouldColor({ mode: 'never', isTTY: true, env: {} }), false);
});

test('toJsonResults produces the documented shape', () => {
  const [r] = toJsonResults([okRemote]);
  assert.deepEqual(Object.keys(r).sort(), ['code', 'deduped', 'error', 'input', 'meta', 'mode', 'ms', 'provider', 'shortUrl'].sort());
  assert.equal(r.shortUrl, 'https://is.gd/Ab3xYz');
  assert.equal(r.error, null);
  const [f] = toJsonResults([failed]);
  assert.equal(f.shortUrl, null);
  assert.equal(f.error, 'invalid URL (unsupported scheme): ftp://nope');
});

test('formatJson emits valid parseable JSON', () => {
  const out = formatJson([okRemote, failed]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].provider, 'is.gd');
});

test('formatQuiet prints only short URLs, one per line, skipping failures', () => {
  const out = formatQuiet([okRemote, failed, okLocal]);
  assert.equal(out, 'https://is.gd/Ab3xYz\nhttp://localhost:8787/ab3xyz');
});

test('formatHuman (no color) shows the hero URL, source line, and metadata', () => {
  const out = formatHuman([okRemote], { colors: null, showFooter: false });
  assert.match(out, /https:\/\/is\.gd\/Ab3xYz/);
  assert.match(out, /↳ https:\/\/example\.com\/long/);
  assert.match(out, /remote/);
  assert.match(out, /is\.gd/);
  assert.match(out, /142ms/);
});

test('formatHuman marks failures and deduped results', () => {
  const out = formatHuman([failed, okLocal], { colors: null, showFooter: true });
  assert.match(out, /✗/);
  assert.match(out, /invalid URL/);
  assert.match(out, /deduped/);
  // footer counts
  assert.match(out, /1 shortened/);
  assert.match(out, /1 failed/);
});

test('truncate shortens long strings with an ellipsis', () => {
  assert.equal(truncate('hello world', 100), 'hello world');
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(truncate('hello world', 8).length, 8);
});

test('formatRelative renders human deltas', () => {
  const now = Date.parse('2026-06-29T12:00:00.000Z');
  assert.equal(formatRelative('2026-06-29T11:59:50.000Z', now), 'just now');
  assert.equal(formatRelative('2026-06-29T11:57:00.000Z', now), '3m ago');
  assert.equal(formatRelative('2026-06-29T09:00:00.000Z', now), '3h ago');
  assert.equal(formatRelative('2026-06-27T12:00:00.000Z', now), '2d ago');
  assert.equal(formatRelative(null, now), '—');
});
