/** The default command: shorten one or more URLs from args / file / stdin. */

import { collectUrls, InputError } from '../input.js';
import { shortenMany } from '../shorten.js';
import { formatHuman, formatJson, formatQuiet, renderQr, createSpinner } from '../output.js';
import { copyToClipboard } from '../clipboard.js';
import { EXIT, PROVIDER_NAMES } from '../constants.js';

function spinnerLabel(inputs) {
  if (inputs.length > 1) return `shortening ${inputs.length} URLs…`;
  try {
    return `shortening ${new URL(/^[a-z]+:\/\//i.test(inputs[0]) ? inputs[0] : `https://${inputs[0]}`).host}…`;
  } catch {
    return 'shortening…';
  }
}

/**
 * @param {import('../context.js').createContext} ctx
 * @param {string[]} urls positional URL args
 * @param {object} cmdOpts command flags
 * @returns {Promise<number>} exit code
 */
export async function shortenCommand(ctx, urls = [], cmdOpts = {}) {
  // 1. Collect inputs from args + file + stdin.
  let inputs;
  try {
    inputs = await collectUrls({
      args: urls,
      filePath: cmdOpts.file || null,
      stdin: ctx.stdin,
      stdinIsTTY: Boolean(ctx.stdin?.isTTY),
    });
  } catch (err) {
    if (err instanceof InputError) {
      ctx.fail(err.message);
      return EXIT.NOINPUT;
    }
    throw err;
  }

  if (inputs.length === 0) {
    ctx.errLine('Usage: shrt <url> [url...]    (or pipe URLs via stdin, or -f <file>)');
    ctx.errLine("Run 'shrt --help' for more.");
    return EXIT.USAGE;
  }

  // 2. Resolve run options (flags override config).
  const mode = cmdOpts.mode || ctx.config.mode;
  if (mode !== 'local' && mode !== 'remote') {
    ctx.fail(`invalid mode "${mode}" (use local or remote)`);
    return EXIT.USAGE;
  }
  const providerFlagged = cmdOpts.provider !== undefined;
  if (providerFlagged && !PROVIDER_NAMES.includes(cmdOpts.provider)) {
    ctx.fail(`unknown provider "${cmdOpts.provider}" (choose from: ${PROVIDER_NAMES.join(', ')})`);
    return EXIT.USAGE;
  }

  if (cmdOpts.alias && inputs.length > 1) {
    ctx.fail('--alias can only be used with a single URL');
    return EXIT.USAGE;
  }
  if (cmdOpts.alias && mode !== 'local') {
    ctx.fail('--alias requires local mode (use -m local)');
    return EXIT.USAGE;
  }

  const runOpts = {
    mode,
    provider: cmdOpts.provider || ctx.config.provider,
    fallback: providerFlagged ? [] : ctx.config.providerFallback,
    timeoutMs: ctx.config.timeoutMs,
    codeLength: ctx.config.codeLength,
    localBaseUrl: ctx.config.localBaseUrl,
    alias: cmdOpts.alias,
    tags: cmdOpts.tags,
    force: Boolean(cmdOpts.force),
    allowPrivate: ctx.allowPrivate || ctx.config.allowPrivateHosts,
  };

  // 3. Run (with a spinner on TTY for network / multi-URL work).
  const spinnerEnabled = Boolean(ctx.stdout.isTTY) && !ctx.quiet && !ctx.json && (mode === 'remote' || inputs.length > 1);
  const spinner = createSpinner({ stream: ctx.stderr, enabled: spinnerEnabled });
  spinner.start(spinnerLabel(inputs));

  let results;
  try {
    results = await shortenMany({ db: ctx.getDb(), fetchImpl: ctx.fetchImpl }, inputs, runOpts);
  } finally {
    spinner.stop();
  }

  // 4. Output. Successes → stdout, failures → stderr, so stdout stays pipe-clean
  //    even in human mode (the spec's "errors to stderr, results to stdout").
  const okResults = results.filter((r) => r.ok);
  const failResults = results.filter((r) => !r.ok);
  if (ctx.json) {
    ctx.outLine(formatJson(results));
  } else if (ctx.quiet) {
    const q = formatQuiet(results);
    if (q) ctx.outLine(q);
  } else {
    if (okResults.length) ctx.outLine(formatHuman(okResults, { colors: ctx.colors, verbose: ctx.verbose, showFooter: false }));
    if (failResults.length) ctx.errLine(formatHuman(failResults, { colors: ctx.colors, verbose: ctx.verbose, showFooter: false }));
    if (results.length > 1) {
      const deduped = okResults.filter((r) => r.deduped).length;
      const parts = [`${okResults.length} shortened`, `${failResults.length} failed`];
      if (deduped) parts.push(`${deduped} deduped`);
      const footer = parts.join(', ');
      ctx.errLine(ctx.colors ? (failResults.length ? ctx.colors.yellow(footer) : ctx.colors.green(footer)) : footer);
    }
  }

  // 5. Optional QR codes (human mode only).
  if (cmdOpts.qr && !ctx.quiet && !ctx.json) {
    for (const r of results.filter((r) => r.ok)) {
      const qr = await renderQr(r.shortUrl);
      ctx.outLine('');
      ctx.out(qr.endsWith('\n') ? qr : `${qr}\n`);
    }
  }

  // 6. Optional clipboard copy (first success).
  if (cmdOpts.copy || ctx.config.copyToClipboard) {
    const first = results.find((r) => r.ok);
    if (first) {
      const res = await copyToClipboard(first.shortUrl);
      if (res.ok) ctx.info(`copied to clipboard (${res.tool})`);
      else ctx.warn('clipboard unavailable (install xclip, wl-clipboard, or xsel)');
    }
  }

  // 7. Verbose diagnostics → stderr.
  if (ctx.verbose) {
    for (const r of results) {
      if (r.attempts) {
        for (const a of r.attempts) ctx.info(`${r.input}: ${a.provider} → ${a.ok ? `ok (${a.ms}ms)` : a.error}`);
      }
    }
    ctx.info(`db: ${ctx.dbPath}`);
  }

  // 8. Exit code reflects batch outcome.
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  if (failed === 0) return EXIT.OK;
  if (ok === 0) return EXIT.FAIL;
  return EXIT.PARTIAL;
}
