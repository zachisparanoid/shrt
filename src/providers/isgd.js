/** is.gd provider — the zero-config default. Simple GET, plain-text response. */
import { requestText, ProviderError } from './http.js';

export const name = 'is.gd';

/**
 * @param {string} longUrl
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ shortUrl: string, provider: string }>}
 */
export async function shorten(longUrl, { fetchImpl, signal, env = process.env } = {}) {
  // Endpoint is overridable for proxies / self-hosted is.gd-compatible mirrors.
  const base = env.SHRT_ISGD_ENDPOINT || 'https://is.gd/create.php';
  const url = `${base}?format=simple&url=${encodeURIComponent(longUrl)}`;
  const { text, status } = await requestText(url, { fetchImpl, signal, provider: name });
  if (!text || text.startsWith('Error:') || !/^https?:\/\//i.test(text)) {
    throw new ProviderError(`is.gd: ${text || `HTTP ${status}`}`, { provider: name });
  }
  return { shortUrl: text, provider: name };
}

export default { name, shorten };
