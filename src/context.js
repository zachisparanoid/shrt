/**
 * Builds the command context: resolved config, paths, color decision, stream
 * handles, a lazily-opened DB, and small output helpers. Commands depend only
 * on this object (no globals), which keeps them testable.
 */

import { resolvePaths, loadConfig } from './config.js';
import { shouldColor, makeColors } from './output.js';
import { openDb, closeDb } from './db.js';

/**
 * @param {object} opts
 * @param {Record<string, unknown>} [opts.globalOpts] merged commander options
 * @param {Record<string, unknown>} [opts.overrides] config overrides (typed)
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {NodeJS.WriteStream} [opts.stdout]
 * @param {NodeJS.WriteStream} [opts.stderr]
 * @param {NodeJS.ReadStream} [opts.stdin]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createContext({
  globalOpts = {},
  overrides = {},
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  fetchImpl,
} = {}) {
  const paths = resolvePaths(env);
  const configPath = globalOpts.config || paths.configPath;
  const dbPath = globalOpts.db || paths.dbPath;

  const { config, sources, warnings } = loadConfig({ configPath, env, overrides });

  const useColor = shouldColor({
    mode: config.color,
    noColor: globalOpts.color === false,
    isTTY: Boolean(stdout.isTTY),
    env,
  });
  const colors = useColor ? makeColors(true) : null;

  let db = null;

  const ctx = {
    config,
    sources,
    warnings,
    paths,
    configPath,
    dbPath,
    colors,
    useColor,
    json: Boolean(globalOpts.json),
    quiet: Boolean(globalOpts.quiet),
    verbose: Boolean(globalOpts.verbose),
    allowPrivate: Boolean(globalOpts.allowPrivate),
    env,
    stdout,
    stderr,
    stdin,
    fetchImpl,

    getDb() {
      if (!db) db = openDb(dbPath);
      return db;
    },
    setDb(handle) {
      db = handle;
    },
    closeDb() {
      if (db) {
        closeDb(db);
        db = null;
      }
    },

    // ── output helpers ──
    out: (s) => stdout.write(s),
    err: (s) => stderr.write(s),
    outLine: (s = '') => stdout.write(`${s}\n`),
    errLine: (s = '') => stderr.write(`${s}\n`),
  };

  ctx.ok = (msg) => ctx.outLine(`${colors ? colors.green('✓') : '✓'} ${msg}`);
  ctx.fail = (msg) => ctx.errLine(`${colors ? colors.red('✗') : '✗'} ${msg}`);
  ctx.warn = (msg) => ctx.errLine(`${colors ? colors.yellow('!') : '!'} ${msg}`);
  ctx.info = (msg) => {
    if (ctx.verbose) ctx.errLine(colors ? colors.dim(`· ${msg}`) : `· ${msg}`);
  };
  ctx.note = (msg) => ctx.errLine(colors ? colors.dim(msg) : msg);
  return ctx;
}
