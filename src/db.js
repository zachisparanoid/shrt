/**
 * SQLite persistence layer. This is the ONLY module that contains SQL.
 * Everything else talks to the database through the functions exported here.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/** Thrown when the database cannot be opened or is unusable. */
export class DbError extends Error {
  /** @param {string} message @param {{ path?: string, cause?: unknown }} [opts] */
  constructor(message, { path, cause } = {}) {
    super(message);
    this.name = 'DbError';
    this.path = path;
    this.cause = cause;
  }
}

// ── Prepared-statement cache (per database handle) ───────────────────────────
const stmtCache = new WeakMap();
/** @param {import('better-sqlite3').Database} db @param {string} sql */
function stmt(db, sql) {
  let m = stmtCache.get(db);
  if (!m) {
    m = new Map();
    stmtCache.set(db, m);
  }
  let s = m.get(sql);
  if (!s) {
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}

// ── Migrations ───────────────────────────────────────────────────────────────
// Each entry migrates the schema from version N to N+1. Append, never edit.
const MIGRATIONS = [
  function toV1(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT UNIQUE,
        long_url    TEXT NOT NULL,
        short_url   TEXT NOT NULL,
        mode        TEXT NOT NULL CHECK (mode IN ('local','remote')),
        provider    TEXT,
        created_at  TEXT NOT NULL,
        hits        INTEGER NOT NULL DEFAULT 0,
        last_hit_at TEXT,
        custom      INTEGER NOT NULL DEFAULT 0,
        tags        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_links_long_url   ON links(long_url);
      CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at);
    `);
  },
];

/** Run any pending migrations inside transactions, tracking schema_version. */
function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const current = Number(getMeta(db, 'schema_version') ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    const run = db.transaction(() => {
      MIGRATIONS[v](db);
      setMeta(db, 'schema_version', String(v + 1));
    });
    run();
  }
}

/**
 * Open (and migrate) the database. Pass ':memory:' for tests.
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 * @throws {DbError}
 */
export function openDb(dbPath) {
  try {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    return db;
  } catch (err) {
    throw new DbError(`failed to open database: ${err.message}`, { path: dbPath, cause: err });
  }
}

/** Cleanly close the database, checkpointing the WAL if applicable. */
export function closeDb(db) {
  if (!db || !db.open) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* memory dbs and read-only handles can't checkpoint; ignore */
  }
  db.close();
}

// ── meta key/value ───────────────────────────────────────────────────────────
/** @returns {string|undefined} */
export function getMeta(db, key) {
  const row = stmt(db, 'SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : undefined;
}
export function setMeta(db, key, value) {
  stmt(db, 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value),
  );
}

// ── links CRUD ───────────────────────────────────────────────────────────────
const INSERT_SQL = `
  INSERT INTO links (code, long_url, short_url, mode, provider, created_at, hits, last_hit_at, custom, tags)
  VALUES (@code, @long_url, @short_url, @mode, @provider, @created_at, @hits, @last_hit_at, @custom, @tags)
`;

/**
 * Insert a link row and return it (including the generated id).
 * @param {import('better-sqlite3').Database} db
 * @param {object} row
 * @returns {object}
 */
export function insertLink(db, row) {
  const full = {
    code: null,
    provider: null,
    hits: 0,
    last_hit_at: null,
    custom: 0,
    tags: null,
    ...row,
  };
  const info = stmt(db, INSERT_SQL).run(full);
  return getById(db, Number(info.lastInsertRowid));
}

export function getById(db, id) {
  return stmt(db, 'SELECT * FROM links WHERE id = ?').get(id);
}
export function getByCode(db, code) {
  return stmt(db, 'SELECT * FROM links WHERE code = ?').get(code);
}
export function getByShortUrl(db, shortUrl) {
  return stmt(db, 'SELECT * FROM links WHERE short_url = ? ORDER BY id DESC LIMIT 1').get(shortUrl);
}

/** Resolve by code first, then by numeric id. @returns {object|undefined} */
export function getByCodeOrId(db, value) {
  const byCode = getByCode(db, value);
  if (byCode) return byCode;
  if (/^\d+$/.test(String(value))) return getById(db, Number(value));
  return undefined;
}

/** Most recent reusable (non-custom) local link for a URL. */
export function findReusableLocalLink(db, longUrl) {
  return stmt(
    db,
    "SELECT * FROM links WHERE long_url = ? AND mode = 'local' AND custom = 0 ORDER BY id DESC LIMIT 1",
  ).get(longUrl);
}

/** Most recent remote link for a URL created at/after `sinceIso`. */
export function findRecentRemoteLink(db, longUrl, sinceIso) {
  return stmt(
    db,
    "SELECT * FROM links WHERE long_url = ? AND mode = 'remote' AND created_at >= ? ORDER BY id DESC LIMIT 1",
  ).get(longUrl, sinceIso);
}

/**
 * List/search history.
 * @param {object} opts
 * @param {string} [opts.search]
 * @param {string} [opts.mode]
 * @param {number} [opts.limit=20]
 * @param {boolean} [opts.all]
 * @param {'created'|'hits'} [opts.sort='created']
 * @returns {object[]}
 */
export function listLinks(db, { search, mode, limit = 20, all = false, sort = 'created' } = {}) {
  const where = [];
  const params = [];
  if (mode) {
    where.push('mode = ?');
    params.push(mode);
  }
  if (search) {
    where.push("(long_url LIKE ? OR short_url LIKE ? OR IFNULL(tags, '') LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  let sql = 'SELECT * FROM links';
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += sort === 'hits' ? ' ORDER BY hits DESC, id DESC' : ' ORDER BY id DESC';
  if (!all) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
  return stmt(db, sql).all(...params);
}

/**
 * Increment a code's hit counter and stamp last_hit_at. Returns the updated
 * row, or undefined if the code does not exist.
 */
export function recordHit(db, code, atIso) {
  const info = stmt(db, 'UPDATE links SET hits = hits + 1, last_hit_at = ? WHERE code = ?').run(atIso, code);
  if (info.changes === 0) return undefined;
  return getByCode(db, code);
}

/** @returns {number} rows deleted (0 or 1) */
export function deleteByCodeOrId(db, value) {
  const row = getByCodeOrId(db, value);
  if (!row) return 0;
  return stmt(db, 'DELETE FROM links WHERE id = ?').run(row.id).changes;
}

// ── stats ────────────────────────────────────────────────────────────────────
export function countLinks(db) {
  return stmt(db, 'SELECT COUNT(*) AS n FROM links').get().n;
}
export function sumHits(db) {
  return stmt(db, 'SELECT IFNULL(SUM(hits), 0) AS n FROM links').get().n;
}
export function topByHits(db, limit = 5) {
  return stmt(db, "SELECT * FROM links WHERE mode = 'local' ORDER BY hits DESC, id DESC LIMIT ?").all(limit);
}
