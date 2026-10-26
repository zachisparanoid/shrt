/** Resolve a short URL (local code or remote) back to its destination. */

import { getByCode, getByShortUrl } from '../db.js';
import { validateUrl, isPrivateHost, ValidationError } from '../validate.js';
import { USER_AGENT } from '../providers/http.js';
import { EXIT } from '../constants.js';

/** Try to resolve `input` against the local DB. @returns {object|undefined} */
function lookupLocal(ctx, db, input) {
  // A bare code only ever matches local rows (remote rows store code = NULL).
  const byCode = getByCode(db, input);
  if (byCode) return byCode;
  // An exact stored short_url, but only short-circuit for LOCAL mappings — remote
  // short URLs are resolved over HTTP (per spec) even if we have them in history.
  const byShort = getByShortUrl(db, input);
  if (byShort && byShort.mode === 'local') return byShort;
  // A loopback/local-base URL → treat its first path segment as a code. This
  // matches regardless of the port actually served on (config may differ).
  try {
    const u = new URL(input);
    const baseHost = new URL(ctx.config.localBaseUrl).hostname;
    if (u.hostname === baseHost || isPrivateHost(u.hostname)) {
      const seg = u.pathname.replace(/^\/+/, '').split('/')[0];
      if (seg) {
        const row = getByCode(db, seg);
        if (row) return row;
      }
    }
  } catch {
    /* not a URL → not local */
  }
  return undefined;
}

/** Follow HTTP redirects manually, guarding each hop. */
async function followRedirects(startUrl, { timeoutMs, maxHops = 10, fetchImpl, allowPrivate }) {
  const doFetch = fetchImpl || fetch;
  let current = startUrl;
  let hops = 0;
  while (hops < maxHops) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers: { 'user-agent': USER_AGENT },
      });
    } catch (err) {
      // If we've already followed ≥1 redirect, report the last known Location
      // (the final destination may itself be unreachable, but we resolved it).
      if (hops > 0) break;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    res.body?.cancel?.().catch?.(() => {});

    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) break;
    const next = new URL(location, current).href;
    if (!allowPrivate && isPrivateHost(new URL(next).hostname)) {
      throw new Error(`redirect to private host blocked (${new URL(next).hostname})`);
    }
    current = next;
    hops++;
  }
  return { resolved: current, hops };
}

function emit(ctx, data) {
  if (ctx.json) {
    ctx.outLine(JSON.stringify(data, null, 2));
  } else if (ctx.quiet) {
    ctx.outLine(data.resolved);
  } else {
    const c = ctx.colors;
    const meta = `${data.mode}${data.hops ? ` · ${data.hops} hop${data.hops === 1 ? '' : 's'}` : ''}`;
    ctx.outLine(`${c ? c.green('✓') : '✓'} ${c ? c.bold(c.cyan(data.resolved)) : data.resolved}   ${c ? c.dim(c.magenta(`(${meta})`)) : `(${meta})`}`);
    ctx.outLine(`  ${c ? c.dim(`↳ from ${data.input}`) : `↳ from ${data.input}`}`);
  }
  return EXIT.OK;
}

/**
 * @param {object} ctx
 * @param {string} input short URL or code
 * @param {object} cmdOpts
 * @returns {Promise<number>}
 */
export async function expandCommand(ctx, input, cmdOpts = {}) {
  if (!input) {
    ctx.fail('expand requires a short URL or code');
    return EXIT.USAGE;
  }
  const db = ctx.getDb();

  const local = lookupLocal(ctx, db, input);
  if (local) return emit(ctx, { input, resolved: local.long_url, mode: 'local', hops: 0 });

  // Remote: must be a real, public http(s) URL (unless --allow-private).
  const allowPrivate = ctx.allowPrivate || ctx.config.allowPrivateHosts;
  let target;
  try {
    target = validateUrl(input, { allowPrivate });
  } catch (err) {
    if (err instanceof ValidationError) {
      ctx.fail(err.message);
      return EXIT.FAIL;
    }
    throw err;
  }

  try {
    const { resolved, hops } = await followRedirects(target.url, {
      timeoutMs: ctx.config.timeoutMs,
      fetchImpl: ctx.fetchImpl,
      allowPrivate,
    });
    if (hops === 0) ctx.info('no redirects followed (URL resolved to itself)');
    return emit(ctx, { input, resolved, mode: 'remote', hops });
  } catch (err) {
    ctx.fail(`could not expand: ${err.message}`);
    return EXIT.FAIL;
  }
}
