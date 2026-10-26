/** tinyurl provider — GET, plain-text response (the short URL or an error word). */
import { requestText, ProviderError } from './http.js';

export const name = 'tinyurl';

/**
 * @param {string} longUrl
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ shortUrl: string, provider: string }>}
 */
export async function shorten(longUrl, { fetchImpl, signal, env = process.env } = {}) {
  const base = env.SHRT_TINYURL_ENDPOINT || 'https://tinyurl.com/api-create.php';
  const url = `${base}?url=${encodeURIComponent(longUrl)}`;
  const { text, status } = await requestText(url, { fetchImpl, signal, provider: name });
  if (!text || !/^https?:\/\//i.test(text) || /error/i.test(text)) {
    throw new ProviderError(`tinyurl: ${text || `HTTP ${status}`}`, { provider: name });
  }
  return { shortUrl: text, provider: name };
}

export default { name, shorten };
