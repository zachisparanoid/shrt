/** Delete a history entry / local mapping. */

import { getByCodeOrId, deleteByCodeOrId } from '../db.js';
import { confirm } from '../prompt.js';
import { EXIT } from '../constants.js';

/**
 * @param {object} ctx
 * @param {string} codeOrId
 * @param {object} cmdOpts
 * @returns {Promise<number>}
 */
export async function deleteCommand(ctx, codeOrId, cmdOpts = {}) {
  if (!codeOrId) {
    ctx.fail('delete requires a code or id');
    return EXIT.USAGE;
  }
  const db = ctx.getDb();
  const row = getByCodeOrId(db, codeOrId);
  if (!row) {
    ctx.fail(`no link found for "${codeOrId}"`);
    return EXIT.FAIL;
  }

  if (!cmdOpts.yes) {
    const interactive = Boolean(ctx.stdin?.isTTY) && Boolean(ctx.stderr?.isTTY) && !ctx.json;
    if (!interactive) {
      // Never block on a prompt in a pipe / JSON context.
      ctx.fail('refusing to delete without --yes in a non-interactive context');
      return EXIT.USAGE;
    }
    const yes = await confirm(`Delete ${row.short_url} → ${row.long_url}? [y/N] `, {
      input: ctx.stdin,
      output: ctx.stderr,
    });
    if (!yes) {
      ctx.note('aborted');
      return EXIT.OK;
    }
  }

  deleteByCodeOrId(db, String(row.id));
  if (ctx.json) ctx.outLine(JSON.stringify({ deleted: true, code: row.code ?? null, id: row.id }, null, 2));
  else if (!ctx.quiet) ctx.ok(`deleted ${row.code ? `/${row.code}` : `#${row.id}`} → ${row.long_url}`);
  return EXIT.OK;
}
