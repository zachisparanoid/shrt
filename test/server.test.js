import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, closeDb, insertLink, getByCode } from '../src/db.js';
import { createServer, listen, ServerError } from '../src/server.js';

function seedDb() {
  const db = openDb(':memory:');
  insertLink(db, {
    code: 'abc1234',
    long_url: 'https://example.com/destination',
    short_url: 'http://localhost:8787/abc1234',
    mode: 'local',
    provider: 'local',
    created_at: '2026-06-29T00:00:00.000Z',
    custom: 0,
  });
  return db;
}

async function withServer(db, fn) {
  const server = createServer({ db, config: {}, now: () => Date.parse('2026-06-29T12:00:00Z') });
  const addr = await listen(server, { port: 0 });
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('GET /healthz returns 200 ok', async () => {
  const db = seedDb();
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), 'ok');
  });
  closeDb(db);
});

test('GET /:code 302-redirects to the long URL and increments hits', async () => {
  const db = seedDb();
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/abc1234`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/destination');
  });
  assert.equal(getByCode(db, 'abc1234').hits, 1);
  closeDb(db);
});

test('hits accumulate across multiple redirects', async () => {
  const db = seedDb();
  await withServer(db, async (base) => {
    await fetch(`${base}/abc1234`, { redirect: 'manual' });
    await fetch(`${base}/abc1234`, { redirect: 'manual' });
    await fetch(`${base}/abc1234`, { redirect: 'manual' });
  });
  assert.equal(getByCode(db, 'abc1234').hits, 3);
  closeDb(db);
});

test('GET unknown code returns 404', async () => {
  const db = seedDb();
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/nope999`, { redirect: 'manual' });
    assert.equal(res.status, 404);
  });
  closeDb(db);
});

test('GET / serves a status page mentioning the link count', async () => {
  const db = seedDb();
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /1/); // one link
    assert.match(body.toLowerCase(), /shrt/);
  });
  closeDb(db);
});

test('HEAD /:code redirects without counting a hit', async () => {
  const db = seedDb();
  await withServer(db, async (base) => {
    const res = await fetch(`${base}/abc1234`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(res.status, 302);
  });
  assert.equal(getByCode(db, 'abc1234').hits, 0); // HEAD must not increment
  closeDb(db);
});

test('listen rejects with ServerError on EADDRINUSE', async () => {
  const db = seedDb();
  const a = createServer({ db, config: {} });
  const addr = await listen(a, { port: 0 });
  const b = createServer({ db, config: {} });
  try {
    await assert.rejects(() => listen(b, { port: addr.port }), (err) => {
      assert.ok(err instanceof ServerError);
      assert.equal(err.code, 'EADDRINUSE');
      return true;
    });
  } finally {
    await new Promise((r) => a.close(r));
  }
  closeDb(db);
});
