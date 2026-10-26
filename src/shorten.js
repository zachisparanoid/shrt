/**
 * Orchestrator: turns input strings into short URLs.
 *
 * Responsibilities: validate/normalize, pick local vs remote, apply the dedupe
 * policy, persist to the DB, and return a uniform result object per URL. It
 * never throws for a bad URL — failures come back as `{ ok: false, ... }` so a
 * batch keeps going.
 */

import { validateUrl, isAlreadyShort, ValidationError } from './validate.js';
import { generateUniqueCode, isValidAlias, CodeError } from './codes.js';
import { shortenWithFallback, AggregateProviderError } from './providers/index.js';
import {
  getByCode,
  insertLink,
  findReusableLocalLink,
  findRecentRemoteLink,
  deleteByCodeOrId,
} from './db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** @typedef {import('./db.js').default} Db */

/**
 * @typedef {Object} ShortenResult
 * @property {string} input
 * @property {boolean} ok
 * @property {string} [shortUrl]
 * @property {string|null} [code]
 * @property {string} [longUrl]
 * @property {string} [mode]
 * @property {string} [provider]
 * @property {number} [ms]
 * @property {boolean} [deduped]
 * @property {boolean} [custom]
 * @property {string} [note]
 * @property {string[]} [warnings]
 * @property {object[]} [attempts]
 * @property {string} [error]
 * @property {string} [errorCode]
 */

function nowMs(ctx) {
  return typeof ctx.now === 'function' ? ctx.now() : Date.now();
}
function isoAt(ms) {
  return new Date(ms).toISOString();
}

/** Build a normalized comma-joined tag string (or null). */
function normalizeTags(tags) {
  if (!tags) return null;
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  const clean = list.map((t) => t.trim()).filter(Boolean);
  return clean.length ? clean.join(',') : null;
}

/** Map a stored row to a successful result. */
function rowToResult(input, row, { deduped = false, ms, attempts, warnings, note } = {}) {
  return {
    input,
    ok: true,
    shortUrl: row.short_url,
    code: row.code ?? null,
    longUrl: row.long_url,
    mode: row.mode,
    provider: row.provider,
    ms,
    deduped,
    custom: Boolean(row.custom),
    note,
    warnings: warnings ?? [],
    attempts,
  };
}

function failure(input, message, code, extra = {}) {
  return { input, ok: false, error: message, errorCode: code, deduped: false, warnings: [], ...extra };
}

/** Validate + normalize a single input against the run options. */
function resolveInput(input, opts) {
  const allowPrivate = opts.mode === 'local' ? true : Boolean(opts.allowPrivate);
  const v = validateUrl(input, { allowPrivate }); // throws ValidationError
  const warnings = [];
  if (isAlreadyShort(input)) warnings.push('already short');
  return { ...v, warnings };
}

/** Shorten one already-validated URL in LOCAL mode. */
function shortenLocal(ctx, input, resolved, opts) {
  const { db } = ctx;
  const { url: longUrl, note, warnings } = resolved;
  const base = opts.localBaseUrl.replace(/\/+$/, '');
  const createdAt = isoAt(nowMs(ctx));

  // ── alias path ──
  if (opts.alias) {
    if (!isValidAlias(opts.alias)) {
      return failure(input, `invalid alias "${opts.alias}" (use letters, digits, _ or -, ≤64 chars)`, 'bad_alias');
    }
    const existing = getByCode(db, opts.alias);
    if (existing) {
      if (existing.long_url === longUrl) {
        return rowToResult(input, existing, { deduped: true, note, warnings });
      }
      if (!opts.force) {
        return failure(
          input,
          `alias "${opts.alias}" is already taken → ${existing.long_url} (use --force to reassign)`,
          'alias_taken',
        );
      }
      deleteByCodeOrId(db, opts.alias); // forced reassignment
    }
    const row = insertLink(db, {
      code: opts.alias,
      long_url: longUrl,
      short_url: `${base}/${opts.alias}`,
      mode: 'local',
      provider: 'local',
      created_at: createdAt,
      custom: 1,
      tags: normalizeTags(opts.tags),
    });
    return rowToResult(input, row, { note, warnings });
  }

  // ── auto-code path with dedupe ──
  if (!opts.force) {
    const reuse = findReusableLocalLink(db, longUrl);
    if (reuse) return rowToResult(input, reuse, { deduped: true, note, warnings });
  }

  let code;
  try {
    code = generateUniqueCode({
      length: opts.codeLength ?? 7,
      exists: (c) => Boolean(getByCode(db, c)),
    });
  } catch (err) {
    if (err instanceof CodeError) return failure(input, err.message, 'code_exhausted');
    throw err;
  }

  const row = insertLink(db, {
    code,
    long_url: longUrl,
    short_url: `${base}/${code}`,
    mode: 'local',
    provider: 'local',
    created_at: createdAt,
    custom: 0,
    tags: normalizeTags(opts.tags),
  });
  return rowToResult(input, row, { note, warnings });
}

/** Shorten one already-validated URL in REMOTE mode. */
async function shortenRemote(ctx, input, resolved, opts) {
  const { db } = ctx;
  const { url: longUrl, note, warnings } = resolved;

  if (!opts.force) {
    const since = isoAt(nowMs(ctx) - DAY_MS);
    const recent = findRecentRemoteLink(db, longUrl, since);
    if (recent) return rowToResult(input, recent, { deduped: true, note, warnings });
  }

  let result;
  try {
    result = await shortenWithFallback(longUrl, {
      provider: opts.provider,
      fallback: opts.fallback ?? [],
      timeoutMs: opts.timeoutMs ?? 8000,
      fetchImpl: ctx.fetchImpl,
      onAttempt: opts.onAttempt,
    });
  } catch (err) {
    if (err instanceof AggregateProviderError) {
      return failure(input, 'all providers failed', 'providers', { attempts: err.attempts });
    }
    throw err;
  }

  const row = insertLink(db, {
    code: null,
    long_url: longUrl,
    short_url: result.shortUrl,
    mode: 'remote',
    provider: result.provider,
    created_at: isoAt(nowMs(ctx)),
    custom: 0,
    tags: normalizeTags(opts.tags),
  });
  return rowToResult(input, row, { ms: result.ms, attempts: result.attempts, note, warnings });
}

/**
 * Shorten a single input. Never throws for bad input.
 * @param {{ db: any, fetchImpl?: typeof fetch, now?: () => number }} ctx
 * @param {string} input
 * @param {object} opts
 * @returns {Promise<ShortenResult>}
 */
export async function shortenOne(ctx, input, opts) {
  let resolved;
  try {
    resolved = resolveInput(input, opts);
  } catch (err) {
    if (err instanceof ValidationError) return failure(input, err.message, err.code);
    throw err;
  }
  return opts.mode === 'local'
    ? shortenLocal(ctx, input, resolved, opts)
    : shortenRemote(ctx, input, resolved, opts);
}

/** Run an async mapper over items with a bounded concurrency pool. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Shorten a batch. Dedupes identical normalized URLs within the batch (so the
 * network/API is hit at most once per unique URL), processes local sequentially
 * and remote with concurrency ≤ 4.
 * @param {object} ctx
 * @param {string[]} inputs
 * @param {object} opts
 * @returns {Promise<ShortenResult[]>}
 */
export async function shortenMany(ctx, inputs, opts) {
  const results = new Array(inputs.length);

  // Pre-resolve to find invalids and group duplicates by normalized URL.
  const firstIndexByUrl = new Map();
  const toProcess = [];
  const resolvedByIndex = new Array(inputs.length);

  inputs.forEach((input, i) => {
    try {
      const resolved = resolveInput(input, opts);
      resolvedByIndex[i] = resolved;
      if (firstIndexByUrl.has(resolved.url)) {
        results[i] = { __dupOf: firstIndexByUrl.get(resolved.url), input };
      } else {
        firstIndexByUrl.set(resolved.url, i);
        toProcess.push(i);
      }
    } catch (err) {
      results[i] =
        err instanceof ValidationError ? failure(input, err.message, err.code) : failure(input, String(err), 'error');
    }
  });

  const runOne = (i) =>
    opts.mode === 'local'
      ? Promise.resolve(shortenLocal(ctx, inputs[i], resolvedByIndex[i], opts))
      : shortenRemote(ctx, inputs[i], resolvedByIndex[i], opts);

  if (opts.mode === 'local') {
    // Sequential: keeps code generation race-free and DB writes ordered.
    for (const i of toProcess) results[i] = await runOne(i);
  } else {
    const processed = await mapPool(toProcess, 4, (i) => runOne(i));
    toProcess.forEach((i, k) => {
      results[i] = processed[k];
    });
  }

  // Resolve in-batch duplicates against their primary result.
  results.forEach((r, i) => {
    if (r && r.__dupOf !== undefined) {
      const base = results[r.__dupOf];
      results[i] = base?.ok ? { ...base, input: r.input, deduped: true } : failure(r.input, base?.error ?? 'failed', base?.errorCode ?? 'error');
    }
  });

  return results;
}
