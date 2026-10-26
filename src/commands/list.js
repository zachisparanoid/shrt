/** List / search local history. */

import { listLinks } from '../db.js';
import { formatListTable } from '../output.js';
import { rowToJson } from './_shared.js';
import { EXIT } from '../constants.js';

/**
 * @param {object} ctx
 * @param {object} cmdOpts
 * @returns {Promise<number>}
 */
export async function listCommand(ctx, cmdOpts = {}) {
  const db = ctx.getDb();
  const all = Boolean(cmdOpts.all);
  const rows = listLinks(db, {
    search: cmdOpts.search,
    mode: cmdOpts.mode,
    limit: all ? Number.MAX_SAFE_INTEGER : Number(cmdOpts.limit ?? 20),
    all,
    sort: cmdOpts.sort === 'hits' ? 'hits' : 'created',
  });

  if (ctx.json) {
    ctx.outLine(JSON.stringify(rows.map(rowToJson), null, 2));
    return EXIT.OK;
  }
  if (ctx.quiet) {
    if (rows.length) ctx.outLine(rows.map((r) => r.short_url).join('\n'));
    return EXIT.OK;
  }
  if (rows.length === 0) {
    const msg = 'No links yet. Run `shrt <url>` to create one.';
    ctx.outLine(ctx.colors ? ctx.colors.dim(msg) : msg);
    return EXIT.OK;
  }
  ctx.outLine(formatListTable(rows, { colors: ctx.colors, termWidth: ctx.stdout.columns || 80 }));
  if (!all && rows.length >= Number(cmdOpts.limit ?? 20)) {
    ctx.info('showing most recent results; use --all or --limit <n> for more');
  }
  return EXIT.OK;
}
