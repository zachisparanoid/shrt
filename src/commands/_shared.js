/** Helpers shared by read commands (list / stats). */

/** Map a DB row to a clean, camelCased JSON object. */
export function rowToJson(r) {
  return {
    id: r.id,
    code: r.code ?? null,
    longUrl: r.long_url,
    shortUrl: r.short_url,
    mode: r.mode,
    provider: r.provider ?? null,
    createdAt: r.created_at,
    hits: r.hits ?? 0,
    lastHitAt: r.last_hit_at ?? null,
    custom: Boolean(r.custom),
    tags: r.tags ? r.tags.split(',') : [],
  };
}
