/** Show aggregate stats, or a single link's full record. */

import { getByCodeOrId, countLinks, sumHits, topByHits } from '../db.js';
import { formatRelative } from '../output.js';
import { rowToJson } from './_shared.js';
import { EXIT } from '../constants.js';

function printRecord(ctx, row) {
  const c = ctx.colors;
  const label = (s) => (c ? c.dim(s) : s);
  const val = (s) => (c ? c.bold(String(s)) : String(s));
  ctx.outLine(`${c ? c.cyan(c.bold(row.short_url)) : row.short_url}`);
  ctx.outLine(`  ${label('target  ')} ${row.long_url}`);
  ctx.outLine(`  ${label('code    ')} ${row.code ?? '—'}${row.custom ? ' (custom)' : ''}`);
  ctx.outLine(`  ${label('mode    ')} ${row.mode}${row.provider ? ` / ${row.provider}` : ''}`);
  ctx.outLine(`  ${label('hits    ')} ${val(row.hits ?? 0)}`);
  ctx.outLine(`  ${label('created ')} ${formatRelative(row.created_at)} (${row.created_at})`);
  ctx.outLine(`  ${label('last hit')} ${row.last_hit_at ? `${formatRelative(row.last_hit_at)} (${row.last_hit_at})` : '—'}`);
  if (row.tags) ctx.outLine(`  ${label('tags    ')} ${row.tags}`);
}

/**
 * @param {object} ctx
 * @param {string|undefined} code
 * @param {object} cmdOpts
 * @returns {Promise<number>}
 */
export async function statsCommand(ctx, code, _cmdOpts = {}) {
  const db = ctx.getDb();

  if (code) {
    const row = getByCodeOrId(db, code);
    if (!row) {
      ctx.fail(`no link found for "${code}"`);
      return EXIT.FAIL;
    }
    if (ctx.json) ctx.outLine(JSON.stringify(rowToJson(row), null, 2));
    else printRecord(ctx, row);
    return EXIT.OK;
  }

  const totalLinks = countLinks(db);
  const totalHits = sumHits(db);
  const top = topByHits(db, 5).filter((r) => r.hits > 0);

  if (ctx.json) {
    ctx.outLine(JSON.stringify({ totalLinks, totalHits, top: top.map(rowToJson) }, null, 2));
    return EXIT.OK;
  }

  const c = ctx.colors;
  ctx.outLine(`${c ? c.bold('shrt stats') : 'shrt stats'}`);
  ctx.outLine(`  ${c ? c.dim('links') : 'links'}: ${totalLinks}    ${c ? c.dim('total hits') : 'total hits'}: ${totalHits}`);
  if (top.length) {
    ctx.outLine('');
    ctx.outLine(c ? c.bold(c.underline('top links')) : 'top links');
    for (const r of top) {
      ctx.outLine(`  ${c ? c.cyan(r.code ?? r.short_url) : (r.code ?? r.short_url)}  ${c ? c.bold(String(r.hits)) : r.hits} hits  ${c ? c.dim(r.long_url) : r.long_url}`);
    }
  } else {
    ctx.outLine(c ? c.dim('  no hits recorded yet (local links accrue hits when served via `shrt serve`)') : '  no hits recorded yet');
  }
  return EXIT.OK;
}
