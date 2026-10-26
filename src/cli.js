/**
 * CLI entry point: commander wiring, context construction, the per-command run
 * loop, and the top-level error → exit-code mapping.
 */

import { Command } from 'commander';
import { VERSION } from './version.js';
import { EXIT } from './constants.js';
import { createContext } from './context.js';
import { shortenCommand } from './commands/shorten.js';
import { expandCommand } from './commands/expand.js';
import { listCommand } from './commands/list.js';
import { statsCommand } from './commands/stats.js';
import { deleteCommand } from './commands/delete.js';
import { serveCommand } from './commands/serve.js';
import { configCommand } from './commands/config.js';

// ── reusable option groups ───────────────────────────────────────────────────
const addOutputFlags = (cmd) =>
  cmd
    .option('-j, --json', 'output machine-readable JSON')
    .option('-q, --quiet', 'print only essential output (pipe-friendly)')
    .option('-v, --verbose', 'verbose diagnostics on stderr');

const addNetworkFlags = (cmd) =>
  cmd
    .option('--timeout <ms>', 'network timeout in milliseconds')
    .option('--allow-private', 'allow private/loopback hosts (overrides SSRF guard)');

const addShortenFlags = (cmd) =>
  cmd
    .option('-m, --mode <mode>', 'local or remote (overrides config)')
    .option('-p, --provider <name>', 'force a specific remote provider (skips fallback)')
    .option('-a, --alias <code>', 'custom short code (local mode only)')
    .option('--tags <list>', 'comma-separated tags to attach to history')
    .option('--force', 'bypass dedupe; force a fresh mapping/request')
    .option('--qr', 'also render a QR code of the short URL')
    .option('-c, --copy', 'copy the first short URL to the clipboard')
    .option('-f, --file <path>', 'read newline-separated URLs from a file');

/**
 * Build a fresh program. Streams/env are injectable for testing.
 * @param {{ stdout?: any, stderr?: any, stdin?: any, env?: any, fetchImpl?: any }} [io]
 */
export function buildProgram(io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const stdin = io.stdin || process.stdin;
  const env = io.env || process.env;

  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: (s) => stdout.write(s),
    writeErr: (s) => stderr.write(s),
  });

  /** Map a thrown error to a friendly message + exit code. */
  function handleError(err, ctx) {
    const emit = ctx ? (m) => ctx.fail(m) : (m) => stderr.write(`✗ ${m}\n`);
    switch (err?.name) {
      case 'ConfigError':
        emit(`config error${err.key ? ` (${err.key})` : ''}: ${err.message}`);
        process.exitCode = EXIT.USAGE;
        return;
      case 'DbError':
        emit(`database error: ${err.message}`);
        if (err.path) {
          stderr.write(`  database file: ${err.path}\n`);
          stderr.write(`  if it is corrupt, remove it and retry: rm ${err.path}*\n`);
        }
        process.exitCode = EXIT.SOFTWARE;
        return;
      case 'InputError':
        emit(err.message);
        process.exitCode = err.code === 'noinput' ? EXIT.NOINPUT : EXIT.USAGE;
        return;
      case 'ServerError':
        emit(err.message);
        process.exitCode = EXIT.TEMPFAIL;
        return;
      default:
        emit(`unexpected error: ${err?.message ?? err}`);
        if (ctx?.verbose && err?.stack) stderr.write(`${err.stack}\n`);
        process.exitCode = EXIT.SOFTWARE;
    }
  }

  /** Build context, run a handler, manage exit code + cleanup. */
  async function run(command, handler, positional) {
    const globalOpts = command.optsWithGlobals();
    const cmdOpts = command.opts();
    const overrides = {};
    if (globalOpts.timeout !== undefined) overrides.timeoutMs = Number(globalOpts.timeout);

    let ctx;
    try {
      ctx = createContext({ globalOpts, overrides, env, stdout, stderr, stdin, fetchImpl: io.fetchImpl });
    } catch (err) {
      handleError(err, null);
      return;
    }

    for (const w of ctx.warnings) ctx.warn(w);

    try {
      const code = await handler(ctx, ...positional, cmdOpts);
      process.exitCode = code ?? EXIT.OK;
    } catch (err) {
      handleError(err, ctx);
    } finally {
      ctx.closeDb();
    }
  }

  // ── root / default (shorten) ──
  program
    .name('shrt')
    .description('Fast URL shortener — remote providers by default, or a local self-hosted shortener.')
    .version(VERSION, '-V, --version', 'print version')
    .option('--config <path>', 'use an alternate config file')
    .option('--db <path>', 'use an alternate database file')
    .option('--no-color', 'disable colored output')
    .argument('[urls...]', 'URL(s) to shorten');
  addOutputFlags(program);
  addNetworkFlags(program);
  addShortenFlags(program);
  program.action((urls, _opts, command) => run(command, shortenCommand, [urls]));

  // ── shorten (explicit) ──
  const shortenCmd = program.command('shorten [urls...]').description('shorten one or more URLs (this is the default command)');
  addOutputFlags(shortenCmd);
  addNetworkFlags(shortenCmd);
  addShortenFlags(shortenCmd);
  shortenCmd.action((urls, _opts, command) => run(command, shortenCommand, [urls]));

  // ── expand ──
  const expandCmd = program
    .command('expand <shortUrlOrCode>')
    .description('resolve a short URL or local code back to its destination');
  addOutputFlags(expandCmd);
  addNetworkFlags(expandCmd);
  expandCmd.action((input, _opts, command) => run(command, expandCommand, [input]));

  // ── list ──
  const listCmd = program.command('list').alias('ls').description('list / search local history');
  addOutputFlags(listCmd);
  listCmd
    .option('--search <text>', 'substring match on long/short URL and tags')
    .option('--mode <mode>', 'filter by local or remote')
    .option('--limit <n>', 'maximum rows to show (default 20)')
    .option('--all', 'show all rows (no limit)')
    .option('--sort <field>', 'sort by created (default) or hits');
  listCmd.action((_opts, command) => run(command, listCommand, []));

  // ── stats ──
  const statsCmd = program.command('stats [code]').description('show aggregate stats, or one link record');
  addOutputFlags(statsCmd);
  statsCmd.action((code, _opts, command) => run(command, statsCommand, [code]));

  // ── delete ──
  const deleteCmd = program.command('delete <codeOrId>').alias('rm').description('delete a history entry / local mapping');
  addOutputFlags(deleteCmd);
  deleteCmd.option('-y, --yes', 'skip the confirmation prompt');
  deleteCmd.action((codeOrId, _opts, command) => run(command, deleteCommand, [codeOrId]));

  // ── serve ──
  const serveCmd = program.command('serve').description('run the local redirect server');
  addOutputFlags(serveCmd);
  serveCmd
    .option('--port <n>', 'port to listen on (default from config)')
    .option('--host <host>', 'host/interface to bind (default 127.0.0.1)')
    .option('--daemon', 'run detached in the background')
    .option('--stop', 'stop a running background server')
    .option('--status', 'report whether the server is running');
  serveCmd.action((_opts, command) => run(command, serveCommand, []));

  // ── config ──
  const configCmd = program
    .command('config [action] [key] [value]')
    .description('get/set/reset config or print paths (actions: get, set, reset, path)');
  addOutputFlags(configCmd);
  configCmd.option('-y, --yes', 'skip the confirmation prompt (reset)');
  configCmd.action((action, key, value, _opts, command) => run(command, configCommand, [action, key, value]));

  program.addHelpText(
    'after',
    `
Examples:
  $ shrt https://example.com/very/long/path     shorten via is.gd (zero config)
  $ shrt url1 url2 url3                          shorten several at once
  $ echo https://example.com | shrt             shorten from stdin
  $ cat urls.txt | shrt -q                       batch from stdin, pipe-friendly
  $ shrt -f urls.txt                             batch from a file
  $ shrt -m local https://example.com            store a local mapping
  $ shrt serve                                    serve local redirects on :8787
  $ shrt expand https://is.gd/abc123             resolve a short URL
  $ shrt list --search docs                       search history
  $ shrt -j https://example.com | jq -r '.[0].shortUrl'

Exit codes: 0 ok · 1 all failed · 2 partial · 64 usage · 66 input file · 70 internal/db · 75 server bind`,
  );

  return program;
}

/**
 * Parse argv and run. Sets process.exitCode; resolves when done.
 * @param {string[]} [argv]
 */
export async function main(argv = process.argv) {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    // commander throws (exitOverride) for help/version/parse errors.
    if (err && typeof err.code === 'string' && err.code.startsWith('commander.')) {
      const clean = ['commander.helpDisplayed', 'commander.version', 'commander.help'];
      process.exitCode = clean.includes(err.code) ? EXIT.OK : EXIT.USAGE;
      return;
    }
    process.stderr.write(`✗ ${err?.message ?? err}\n`);
    process.exitCode = EXIT.SOFTWARE;
  }
}
