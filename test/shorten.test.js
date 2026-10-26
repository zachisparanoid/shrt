import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, countLinks, getByCode } from '../src/db.js';
import { shortenOne, shortenMany } from '../src/shorten.js';

const T = Date.parse('2026-06-29T12:00:00.000Z');

/** Stub fetch that always shortens via "is.gd", counting calls. */
function counterFetch() {
  const state = { calls: 0 };
  const fetchImpl = async (url) => {
    state.calls++;
    const body = url.includes('is.gd') ? 'https://is.gd/abc12' : 'https://tinyurl.com/xy';
    return { status: 200, ok: true, async text() { return body; }, headers: new Map() };
  };
  return { fetchImpl, state };
}

function ctxWith(fetchImpl, now = () => T) {
  return { db: openDb(':memory:'), fetchImpl, now };
}

const REMOTE = { mode: 'remote', provider: 'is.gd', fallback: ['tinyurl'], timeoutMs: 8000, allowPrivate: false };
const LOCAL = { mode: 'local', codeLength: 7, localBaseUrl: 'http://localhost:8787', allowPrivate: false };

test('remote: shortens and persists a row', async () => {
  const { fetchImpl, state } = counterFetch();
  const ctx = ctxWith(fetchImpl);
  const r = await shortenOne(ctx, 'https://example.com/long/path', REMOTE);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'remote');
  assert.equal(r.provider, 'is.gd');
  assert.equal(r.shortUrl, 'https://is.gd/abc12');
  assert.equal(r.code, null);
  assert.equal(state.calls, 1);
  assert.equal(countLinks(ctx.db), 1);
  closeDb(ctx.db);
});

test('remote: dedupes an identical URL within 24h (no second API call)', async () => {
  const { fetchImpl, state } = counterFetch();
  const ctx = ctxWith(fetchImpl);
  await shortenOne(ctx, 'https://example.com/x', REMOTE);
  const r2 = await shortenOne(ctx, 'https://example.com/x', REMOTE);
  assert.equal(r2.deduped, true);
  assert.equal(state.calls, 1); // not hammered
  assert.equal(countLinks(ctx.db), 1);
  closeDb(ctx.db);
});

test('remote: --force bypasses dedupe', async () => {
  const { fetchImpl, state } = counterFetch();
  const ctx = ctxWith(fetchImpl);
  await shortenOne(ctx, 'https://example.com/x', REMOTE);
  const r2 = await shortenOne(ctx, 'https://example.com/x', { ...REMOTE, force: true });
  assert.equal(r2.deduped, false);
  assert.equal(state.calls, 2);
  assert.equal(countLinks(ctx.db), 2);
  closeDb(ctx.db);
});

test('remote: dedupe window expires after 24h', async () => {
  const { fetchImpl, state } = counterFetch();
  let clock = T;
  const ctx = ctxWith(fetchImpl, () => clock);
  await shortenOne(ctx, 'https://example.com/x', REMOTE);
  clock = T + 25 * 3600 * 1000; // 25h later
  const r2 = await shortenOne(ctx, 'https://example.com/x', REMOTE);
  assert.equal(r2.deduped, false);
  assert.equal(state.calls, 2);
  closeDb(ctx.db);
});

test('remote: SSRF guard rejects a private host', async () => {
  const { fetchImpl } = counterFetch();
  const ctx = ctxWith(fetchImpl);
  const r = await shortenOne(ctx, 'http://192.168.0.1/admin', REMOTE);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'private');
  closeDb(ctx.db);
});

test('local: generates a code and composes the short URL', async () => {
  const ctx = ctxWith(undefined);
  const r = await shortenOne(ctx, 'https://example.com/page', LOCAL);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'local');
  assert.equal(r.provider, 'local');
  assert.equal(r.code.length, 7);
  assert.equal(r.shortUrl, `http://localhost:8787/${r.code}`);
  assert.ok(getByCode(ctx.db, r.code));
  closeDb(ctx.db);
});

test('local: SSRF guard does NOT block private hosts (self-hosting is fine)', async () => {
  const ctx = ctxWith(undefined);
  const r = await shortenOne(ctx, 'http://192.168.0.50/dashboard', LOCAL);
  assert.equal(r.ok, true);
  closeDb(ctx.db);
});

test('local: dedupes identical non-custom URLs to the same code', async () => {
  const ctx = ctxWith(undefined);
  const r1 = await shortenOne(ctx, 'https://example.com/dup', LOCAL);
  const r2 = await shortenOne(ctx, 'https://example.com/dup', LOCAL);
  assert.equal(r1.code, r2.code);
  assert.equal(r2.deduped, true);
  assert.equal(countLinks(ctx.db), 1);
  closeDb(ctx.db);
});

test('local: alias creates a custom code', async () => {
  const ctx = ctxWith(undefined);
  const r = await shortenOne(ctx, 'https://example.com/aliased', { ...LOCAL, alias: 'mylink' });
  assert.equal(r.code, 'mylink');
  assert.equal(r.custom, true);
  assert.equal(r.shortUrl, 'http://localhost:8787/mylink');
  closeDb(ctx.db);
});

test('local: reusing an alias for the SAME url is idempotent (deduped, no error)', async () => {
  const ctx = ctxWith(undefined);
  await shortenOne(ctx, 'https://example.com/same', { ...LOCAL, alias: 'go' });
  const r2 = await shortenOne(ctx, 'https://example.com/same', { ...LOCAL, alias: 'go' });
  assert.equal(r2.ok, true);
  assert.equal(r2.deduped, true);
  closeDb(ctx.db);
});

test('local: reusing an alias for a DIFFERENT url errors without --force', async () => {
  const ctx = ctxWith(undefined);
  await shortenOne(ctx, 'https://example.com/one', { ...LOCAL, alias: 'go' });
  const r2 = await shortenOne(ctx, 'https://example.com/two', { ...LOCAL, alias: 'go' });
  assert.equal(r2.ok, false);
  assert.equal(r2.errorCode, 'alias_taken');
  assert.match(r2.error, /example\.com\/one/); // names the existing target
  closeDb(ctx.db);
});

test('local: --force reassigns an existing alias', async () => {
  const ctx = ctxWith(undefined);
  await shortenOne(ctx, 'https://example.com/one', { ...LOCAL, alias: 'go' });
  const r2 = await shortenOne(ctx, 'https://example.com/two', { ...LOCAL, alias: 'go', force: true });
  assert.equal(r2.ok, true);
  assert.equal(getByCode(ctx.db, 'go').long_url, 'https://example.com/two');
  closeDb(ctx.db);
});

test('local: invalid alias is rejected', async () => {
  const ctx = ctxWith(undefined);
  const r = await shortenOne(ctx, 'https://example.com/x', { ...LOCAL, alias: 'bad/alias' });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'bad_alias');
  closeDb(ctx.db);
});

test('invalid URL yields a failed result, not a throw', async () => {
  const ctx = ctxWith(undefined);
  const r = await shortenOne(ctx, 'not a url at all', LOCAL);
  assert.equal(r.ok, false);
  closeDb(ctx.db);
});

test('shortenMany processes a batch, dedupes within it, and reports errors', async () => {
  const { fetchImpl, state } = counterFetch();
  const ctx = ctxWith(fetchImpl);
  const inputs = [
    'https://example.com/a',
    'ftp://nope', // invalid scheme
    'https://example.com/a', // duplicate of the first (normalized)
  ];
  const results = await shortenMany(ctx, inputs, REMOTE);
  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[2].deduped, true);
  // the duplicate must NOT trigger a second network call
  assert.equal(state.calls, 1);
  closeDb(ctx.db);
});
