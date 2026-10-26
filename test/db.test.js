import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openDb,
  closeDb,
  insertLink,
  getByCode,
  getById,
  getByCodeOrId,
  getByShortUrl,
  findReusableLocalLink,
  findRecentRemoteLink,
  listLinks,
  recordHit,
  deleteByCodeOrId,
  countLinks,
  sumHits,
  topByHits,
  getMeta,
  setMeta,
} from '../src/db.js';

/** Build an in-memory db for each test. */
function freshDb() {
  return openDb(':memory:');
}

/** Minimal link factory. */
function link(overrides = {}) {
  return {
    code: null,
    long_url: 'https://example.com/a',
    short_url: 'https://is.gd/x',
    mode: 'remote',
    provider: 'is.gd',
    created_at: '2026-06-29T00:00:00.000Z',
    custom: 0,
    tags: null,
    ...overrides,
  };
}

test('openDb initializes schema at version 1 with required tables', () => {
  const db = freshDb();
  assert.equal(getMeta(db, 'schema_version'), '1');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes('links'));
  assert.ok(tables.includes('meta'));
  closeDb(db);
});

test('openDb enables WAL and foreign keys', () => {
  // file-backed db required for WAL (memory dbs report "memory")
  const db = freshDb();
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  closeDb(db);
});

test('insertLink returns the stored row with an id', () => {
  const db = freshDb();
  const row = insertLink(db, link({ code: 'abc1234', mode: 'local', provider: 'local', short_url: 'http://localhost:8787/abc1234' }));
  assert.ok(row.id > 0);
  assert.equal(row.code, 'abc1234');
  assert.equal(row.hits, 0);
  assert.equal(row.mode, 'local');
  closeDb(db);
});

test('getByCode / getById / getByShortUrl retrieve rows', () => {
  const db = freshDb();
  const row = insertLink(db, link({ code: 'code123', short_url: 'http://localhost:8787/code123' }));
  assert.equal(getByCode(db, 'code123').id, row.id);
  assert.equal(getById(db, row.id).code, 'code123');
  assert.equal(getByShortUrl(db, 'http://localhost:8787/code123').id, row.id);
  assert.equal(getByCode(db, 'missing'), undefined);
  closeDb(db);
});

test('getByCodeOrId prefers code, falls back to numeric id', () => {
  const db = freshDb();
  const row = insertLink(db, link({ code: 'kept', short_url: 's' }));
  assert.equal(getByCodeOrId(db, 'kept').id, row.id);
  assert.equal(getByCodeOrId(db, String(row.id)).id, row.id);
  assert.equal(getByCodeOrId(db, 'nope'), undefined);
  closeDb(db);
});

test('code column is UNIQUE', () => {
  const db = freshDb();
  insertLink(db, link({ code: 'dup', short_url: 's1' }));
  assert.throws(() => insertLink(db, link({ code: 'dup', short_url: 's2' })));
  closeDb(db);
});

test('multiple remote rows may have NULL code', () => {
  const db = freshDb();
  insertLink(db, link({ code: null, short_url: 's1' }));
  assert.doesNotThrow(() => insertLink(db, link({ code: null, short_url: 's2' })));
  assert.equal(countLinks(db), 2);
  closeDb(db);
});

test('findReusableLocalLink returns non-custom local dupes only', () => {
  const db = freshDb();
  insertLink(db, link({ code: 'c1', mode: 'local', custom: 0, long_url: 'https://dup.com', short_url: 'x' }));
  insertLink(db, link({ code: 'c2', mode: 'local', custom: 1, long_url: 'https://custom.com', short_url: 'x' }));
  insertLink(db, link({ code: null, mode: 'remote', long_url: 'https://dup.com', short_url: 'x' }));

  const reuse = findReusableLocalLink(db, 'https://dup.com');
  assert.equal(reuse.code, 'c1');
  // custom local link is never reused
  assert.equal(findReusableLocalLink(db, 'https://custom.com'), undefined);
  // remote-only url has no reusable local row
  assert.equal(findReusableLocalLink(db, 'https://remote-only.com'), undefined);
  closeDb(db);
});

test('findRecentRemoteLink respects the time window', () => {
  const db = freshDb();
  insertLink(db, link({ mode: 'remote', long_url: 'https://r.com', created_at: '2026-06-28T00:00:00.000Z', short_url: 'old' }));
  // a cutoff after the stored row => no recent match
  assert.equal(findRecentRemoteLink(db, 'https://r.com', '2026-06-29T00:00:00.000Z'), undefined);
  // a cutoff before the stored row => match
  assert.equal(findRecentRemoteLink(db, 'https://r.com', '2026-06-27T00:00:00.000Z').short_url, 'old');
  closeDb(db);
});

test('recordHit increments hits and sets last_hit_at, returns row', () => {
  const db = freshDb();
  insertLink(db, link({ code: 'hitme', mode: 'local', short_url: 'x' }));
  const r1 = recordHit(db, 'hitme', '2026-06-29T01:00:00.000Z');
  assert.equal(r1.hits, 1);
  assert.equal(r1.last_hit_at, '2026-06-29T01:00:00.000Z');
  const r2 = recordHit(db, 'hitme', '2026-06-29T02:00:00.000Z');
  assert.equal(r2.hits, 2);
  assert.equal(recordHit(db, 'unknown', 'now'), undefined);
  closeDb(db);
});

test('deleteByCodeOrId removes rows', () => {
  const db = freshDb();
  const row = insertLink(db, link({ code: 'del', short_url: 'x' }));
  assert.equal(deleteByCodeOrId(db, 'del'), 1);
  assert.equal(getByCode(db, 'del'), undefined);
  // by id
  const row2 = insertLink(db, link({ code: 'del2', short_url: 'x' }));
  assert.equal(deleteByCodeOrId(db, String(row2.id)), 1);
  assert.equal(deleteByCodeOrId(db, 'ghost'), 0);
  closeDb(db);
});

test('listLinks filters by search, mode, limit, and sort', () => {
  const db = freshDb();
  insertLink(db, link({ code: 'a', mode: 'local', long_url: 'https://apple.com', short_url: 'http://localhost/a', hits: 0, created_at: '2026-06-01T00:00:00.000Z' }));
  insertLink(db, link({ code: 'b', mode: 'local', long_url: 'https://banana.com', short_url: 'http://localhost/b', created_at: '2026-06-02T00:00:00.000Z', tags: 'fruit' }));
  insertLink(db, link({ code: null, mode: 'remote', long_url: 'https://cherry.com', short_url: 'https://is.gd/c', created_at: '2026-06-03T00:00:00.000Z' }));
  // bump b's hits
  recordHit(db, 'b', '2026-06-29T00:00:00.000Z');

  assert.equal(listLinks(db, {}).length, 3);
  assert.equal(listLinks(db, { mode: 'remote' }).length, 1);
  assert.equal(listLinks(db, { search: 'banana' })[0].code, 'b');
  assert.equal(listLinks(db, { search: 'fruit' })[0].code, 'b'); // matches tags
  assert.equal(listLinks(db, { limit: 2 }).length, 2);
  // default sort is newest first (by id/created)
  assert.equal(listLinks(db, {})[0].long_url, 'https://cherry.com');
  // sort by hits
  assert.equal(listLinks(db, { sort: 'hits' })[0].code, 'b');
  closeDb(db);
});

test('stats helpers compute totals and top hits', () => {
  const db = freshDb();
  insertLink(db, link({ code: 'x', mode: 'local', short_url: 's' }));
  insertLink(db, link({ code: 'y', mode: 'local', short_url: 's' }));
  recordHit(db, 'x', 't1');
  recordHit(db, 'x', 't2');
  recordHit(db, 'y', 't3');
  assert.equal(countLinks(db), 2);
  assert.equal(sumHits(db), 3);
  const top = topByHits(db, 5);
  assert.equal(top[0].code, 'x');
  assert.equal(top[0].hits, 2);
  closeDb(db);
});

test('meta get/set round-trips', () => {
  const db = freshDb();
  assert.equal(getMeta(db, 'nope'), undefined);
  setMeta(db, 'foo', 'bar');
  assert.equal(getMeta(db, 'foo'), 'bar');
  setMeta(db, 'foo', 'baz');
  assert.equal(getMeta(db, 'foo'), 'baz');
  closeDb(db);
});
