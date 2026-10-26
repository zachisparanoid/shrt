/** cleanuri provider — POST form body, JSON response { result_url } | { error }. */
import { requestText, ProviderError } from './http.js';

export const name = 'cleanuri';

/**
 * @param {string} longUrl
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ shortUrl: string, provider: string }>}
 */
export async function shorten(longUrl, { fetchImpl, signal, env = process.env } = {}) {
  const endpoint = env.SHRT_CLEANURI_ENDPOINT || 'https://cleanuri.com/api/v1/shorten';
  const { text, status } = await requestText(endpoint, {
    fetchImpl,
    signal,
    provider: name,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `url=${encodeURIComponent(longUrl)}`,
  });

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProviderError(`cleanuri: invalid response (HTTP ${status})`, { provider: name });
  }
  if (data.error) throw new ProviderError(`cleanuri: ${data.error}`, { provider: name });
  if (!data.result_url) throw new ProviderError('cleanuri: missing result_url', { provider: name });
  return { shortUrl: data.result_url, provider: name };
}

export default { name, shorten };
