/**
 * Provider registry and fallback chain.
 *
 * A provider is `{ name, shorten(longUrl, { fetchImpl, signal }) }` that resolves
 * to `{ shortUrl, provider }` or throws a ProviderError. The chain tries the
 * primary, then each fallback, recording every attempt.
 */

import isgd from './isgd.js';
import tinyurl from './tinyurl.js';
import cleanuri from './cleanuri.js';
import { ProviderError } from './http.js';

export { ProviderError } from './http.js';

/** name → provider */
export const registry = Object.freeze({
  [isgd.name]: isgd,
  [tinyurl.name]: tinyurl,
  [cleanuri.name]: cleanuri,
});

/** Aggregated failure across the whole chain. */
export class AggregateProviderError extends Error {
  /** @param {string} message @param {Array<{provider:string,ok:boolean,error?:string,ms:number}>} attempts */
  constructor(message, attempts) {
    super(message);
    this.name = 'AggregateProviderError';
    this.attempts = attempts;
  }
}

/** @param {string} providerName @returns {{name:string, shorten:Function}} */
export function getProvider(providerName) {
  const p = registry[providerName];
  if (!p) throw new ProviderError(`unknown provider: ${providerName}`, { provider: providerName, code: 'unknown' });
  return p;
}

/** Validate a provider result before accepting it. @throws {ProviderError} */
function assertGoodResult(shortUrl, longUrl, providerName) {
  let u;
  try {
    u = new URL(shortUrl);
  } catch {
    throw new ProviderError(`${providerName}: returned a non-URL ("${shortUrl}")`, { provider: providerName });
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ProviderError(`${providerName}: returned a non-http(s) URL`, { provider: providerName });
  }
  if (shortUrl.length >= longUrl.length) {
    throw new ProviderError(`${providerName}: result is not shorter than the input`, { provider: providerName });
  }
}

/**
 * Try the primary provider, then each fallback, until one succeeds.
 * @param {string} longUrl
 * @param {object} opts
 * @param {string} opts.provider primary provider name
 * @param {string[]} [opts.fallback=[]] ordered fallback names
 * @param {number} [opts.timeoutMs=8000]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(a: {provider:string, ok:boolean, error?:string, ms:number}) => void} [opts.onAttempt]
 * @returns {Promise<{ shortUrl: string, provider: string, ms: number, attempts: object[] }>}
 * @throws {AggregateProviderError}
 */
export async function shortenWithFallback(longUrl, { provider, fallback = [], timeoutMs = 8000, fetchImpl, onAttempt } = {}) {
  // Build the ordered, de-duplicated chain.
  const seen = new Set();
  const chain = [provider, ...fallback].filter((n) => n && !seen.has(n) && seen.add(n));

  const attempts = [];
  for (const providerName of chain) {
    const start = performance.now();
    const prov = registry[providerName];
    if (!prov) {
      const attempt = { provider: providerName, ok: false, error: 'unknown provider', ms: 0 };
      attempts.push(attempt);
      onAttempt?.(attempt);
      continue;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const result = await prov.shorten(longUrl, { fetchImpl, signal: ac.signal, timeoutMs });
      assertGoodResult(result.shortUrl, longUrl, providerName);
      const ms = Math.round(performance.now() - start);
      const attempt = { provider: providerName, ok: true, ms };
      attempts.push(attempt);
      onAttempt?.(attempt);
      return { shortUrl: result.shortUrl, provider: providerName, ms, attempts };
    } catch (err) {
      const ms = Math.round(performance.now() - start);
      const error = ac.signal.aborted ? `timed out after ${timeoutMs}ms` : err.message;
      const attempt = { provider: providerName, ok: false, error, ms };
      attempts.push(attempt);
      onAttempt?.(attempt);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new AggregateProviderError('all providers failed', attempts);
}
