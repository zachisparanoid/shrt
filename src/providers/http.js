/** Shared HTTP helpers and error types for remote providers. */

import { VERSION } from '../version.js';

/** Sent on every provider request so operators can identify the client. */
export const USER_AGENT = `shrt/${VERSION} (+https://github.com/)`;

/** A single provider's failure (network, timeout, or provider-level error). */
export class ProviderError extends Error {
  /** @param {string} message @param {{ provider?: string, code?: string, cause?: unknown }} [opts] */
  constructor(message, { provider, code = 'provider', cause } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.code = code; // 'provider' | 'network' | 'timeout' | 'unknown'
    this.cause = cause;
  }
}

/**
 * Perform a request and return the trimmed text body.
 * `fetchImpl` is injectable so tests can stub the network.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal, method?: string, headers?: Record<string,string>, body?: string, provider?: string }} [opts]
 * @returns {Promise<{ status: number, ok: boolean, text: string }>}
 */
export async function requestText(url, { fetchImpl = fetch, signal, method = 'GET', headers = {}, body, provider } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      signal,
      body,
      headers: { 'user-agent': USER_AGENT, accept: 'text/plain, application/json', ...headers },
    });
  } catch (err) {
    if (signal?.aborted) {
      throw new ProviderError('request timed out', { provider, code: 'timeout', cause: err });
    }
    throw new ProviderError(`network error: ${err.message}`, { provider, code: 'network', cause: err });
  }
  const text = (await res.text()).trim();
  return { status: res.status, ok: res.ok, text };
}
