import { test } from 'node:test';
import assert from 'node:assert/strict';
import isgd from '../src/providers/isgd.js';
import tinyurl from '../src/providers/tinyurl.js';
import cleanuri from '../src/providers/cleanuri.js';
import {
  shortenWithFallback,
  getProvider,
  ProviderError,
  AggregateProviderError,
} from '../src/providers/index.js';

/** Build a stub fetch returning the given body/status. `handler(url, opts)` may be async. */
function stubFetch(handler) {
  return async (url, opts = {}) => {
    const r = await handler(url, opts);
    const status = r.status ?? 200;
    const body = r.text ?? '';
    return {
      status,
      ok: status >= 200 && status < 400,
      async text() {
        return body;
      },
      headers: new Map(),
    };
  };
}

const LONG = 'https://example.com/a/very/long/path/that/needs/shortening';

test('is.gd returns the short URL on success', async () => {
  const fetchImpl = stubFetch((url) => {
    assert.match(url, /^https:\/\/is\.gd\/create\.php\?format=simple&url=/);
    assert.match(url, /example\.com/);
    return { text: 'https://is.gd/Ab3xYz' };
  });
  const r = await isgd.shorten(LONG, { fetchImpl });
  assert.equal(r.shortUrl, 'https://is.gd/Ab3xYz');
  assert.equal(r.provider, 'is.gd');
});

test('is.gd throws on an Error: body', async () => {
  const fetchImpl = stubFetch(() => ({ text: 'Error: malformed url' }));
  await assert.rejects(() => isgd.shorten(LONG, { fetchImpl }), ProviderError);
});

test('tinyurl returns the short URL on success', async () => {
  const fetchImpl = stubFetch((url) => {
    assert.match(url, /tinyurl\.com\/api-create\.php\?url=/);
    return { text: 'https://tinyurl.com/y8xk2' };
  });
  const r = await tinyurl.shorten(LONG, { fetchImpl });
  assert.equal(r.shortUrl, 'https://tinyurl.com/y8xk2');
});

test('tinyurl throws on a non-URL body', async () => {
  const fetchImpl = stubFetch(() => ({ text: 'Error' }));
  await assert.rejects(() => tinyurl.shorten(LONG, { fetchImpl }), ProviderError);
});

test('cleanuri parses result_url from JSON', async () => {
  const fetchImpl = stubFetch((url, opts) => {
    assert.equal(opts.method, 'POST');
    assert.match(opts.body, /url=https/);
    return { text: JSON.stringify({ result_url: 'https://cleanuri.com/abcd' }) };
  });
  const r = await cleanuri.shorten(LONG, { fetchImpl });
  assert.equal(r.shortUrl, 'https://cleanuri.com/abcd');
});

test('cleanuri throws on an error JSON', async () => {
  const fetchImpl = stubFetch(() => ({ text: JSON.stringify({ error: 'rate limited' }) }));
  await assert.rejects(() => cleanuri.shorten(LONG, { fetchImpl }), ProviderError);
});

test('getProvider returns known providers and throws on unknown', () => {
  assert.equal(getProvider('is.gd').name, 'is.gd');
  assert.throws(() => getProvider('nope'));
});

test('fallback advances past a failing primary and records the winner', async () => {
  // is.gd fails, tinyurl succeeds
  const fetchImpl = stubFetch((url) => {
    if (url.includes('is.gd')) return { text: 'Error: down' };
    if (url.includes('tinyurl')) return { text: 'https://tinyurl.com/win' };
    throw new Error('unexpected url ' + url);
  });
  const r = await shortenWithFallback(LONG, {
    provider: 'is.gd',
    fallback: ['tinyurl', 'cleanuri'],
    fetchImpl,
  });
  assert.equal(r.provider, 'tinyurl');
  assert.equal(r.shortUrl, 'https://tinyurl.com/win');
  assert.equal(r.attempts.length, 2);
  assert.equal(r.attempts[0].ok, false);
  assert.equal(r.attempts[1].ok, true);
});

test('fallback throws AggregateProviderError when all providers fail', async () => {
  const fetchImpl = stubFetch(() => ({ text: 'Error: nope' }));
  await assert.rejects(
    () => shortenWithFallback(LONG, { provider: 'is.gd', fallback: ['tinyurl'], fetchImpl }),
    (err) => {
      assert.ok(err instanceof AggregateProviderError);
      assert.equal(err.attempts.length, 2);
      assert.ok(err.attempts.every((a) => !a.ok));
      return true;
    },
  );
});

test('a provider returning a non-URL is treated as failure (and fallback continues)', async () => {
  const fetchImpl = stubFetch((url) => {
    if (url.includes('is.gd')) return { text: 'not-a-url' };
    return { text: 'https://tinyurl.com/ok' };
  });
  const r = await shortenWithFallback(LONG, { provider: 'is.gd', fallback: ['tinyurl'], fetchImpl });
  assert.equal(r.provider, 'tinyurl');
});

test('a result not shorter than the input is rejected', async () => {
  const longShortish = 'https://x.io/a';
  const fetchImpl = stubFetch(() => ({ text: 'https://this-is-way-longer-than-input.example/zzzz' }));
  await assert.rejects(
    () => shortenWithFallback(longShortish, { provider: 'is.gd', fallback: [], fetchImpl }),
    AggregateProviderError,
  );
});

test('timeout aborts the request and advances the fallback chain', async () => {
  // is.gd never resolves until aborted; tinyurl responds instantly
  const fetchImpl = (url, opts = {}) => {
    if (url.includes('is.gd')) {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return Promise.resolve({
      status: 200,
      ok: true,
      async text() {
        return 'https://tinyurl.com/fast';
      },
      headers: new Map(),
    });
  };
  const r = await shortenWithFallback(LONG, {
    provider: 'is.gd',
    fallback: ['tinyurl'],
    timeoutMs: 60,
    fetchImpl,
  });
  assert.equal(r.provider, 'tinyurl');
  assert.equal(r.attempts[0].ok, false);
  assert.match(r.attempts[0].error, /tim(e|ed)/i);
});
