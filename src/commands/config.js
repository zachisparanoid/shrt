/** Get / set / reset config values and print file locations. */

import { readConfigFile, writeConfigFile, coerceConfigValue, DEFAULTS, ConfigError } from '../config.js';
import { confirm } from '../prompt.js';
import { EXIT } from '../constants.js';

function configGet(ctx, key) {
  if (key) {
    if (!(key in DEFAULTS)) {
      ctx.fail(`unknown config key: ${key}`);
      return EXIT.USAGE;
    }
    const value = ctx.config[key];
    if (ctx.json) ctx.outLine(JSON.stringify(value));
    else ctx.outLine(typeof value === 'object' ? JSON.stringify(value) : String(value));
    return EXIT.OK;
  }

  if (ctx.json) {
    ctx.outLine(JSON.stringify(ctx.config, null, 2));
    return EXIT.OK;
  }
  const c = ctx.colors;
  for (const k of Object.keys(DEFAULTS)) {
    const v = ctx.config[k];
    const shown = typeof v === 'object' ? JSON.stringify(v) : String(v);
    const src = ctx.verbose ? `  ${c ? c.dim(`(${ctx.sources[k]})`) : `(${ctx.sources[k]})`}` : '';
    ctx.outLine(`${c ? c.cyan(k.padEnd(18)) : k.padEnd(18)} ${shown}${src}`);
  }
  return EXIT.OK;
}

function configSet(ctx, key, value) {
  if (!key || value === undefined) {
    ctx.fail('usage: shrt config set <key> <value>');
    return EXIT.USAGE;
  }
  let coerced;
  try {
    coerced = coerceConfigValue(key, value);
  } catch (err) {
    if (err instanceof ConfigError) {
      ctx.fail(`invalid value for ${err.key ?? key}: ${err.message}`);
      return EXIT.USAGE;
    }
    throw err;
  }
  const { parsed } = readConfigFile(ctx.configPath);
  parsed[key] = coerced;
  writeConfigFile(ctx.configPath, parsed);
  ctx.ok(`set ${key} = ${typeof coerced === 'object' ? JSON.stringify(coerced) : coerced}`);
  ctx.info(`written to ${ctx.configPath}`);
  return EXIT.OK;
}

async function configReset(ctx, cmdOpts) {
  if (!cmdOpts.yes) {
    const interactive = Boolean(ctx.stdin?.isTTY) && Boolean(ctx.stderr?.isTTY) && !ctx.json;
    if (!interactive) {
      ctx.fail('refusing to reset without --yes in a non-interactive context');
      return EXIT.USAGE;
    }
    const yes = await confirm(`Reset config at ${ctx.configPath} to defaults? [y/N] `, {
      input: ctx.stdin,
      output: ctx.stderr,
    });
    if (!yes) {
      ctx.note('aborted');
      return EXIT.OK;
    }
  }
  writeConfigFile(ctx.configPath, { ...DEFAULTS });
  ctx.ok('config reset to defaults');
  return EXIT.OK;
}

function configPath(ctx) {
  const data = {
    config: ctx.configPath,
    db: ctx.dbPath,
    pid: ctx.paths.pidPath,
    log: ctx.paths.logPath,
  };
  if (ctx.json) {
    ctx.outLine(JSON.stringify(data, null, 2));
    return EXIT.OK;
  }
  const c = ctx.colors;
  for (const [k, v] of Object.entries(data)) {
    ctx.outLine(`${c ? c.dim(k.padEnd(7)) : k.padEnd(7)} ${v}`);
  }
  return EXIT.OK;
}

/**
 * @param {object} ctx
 * @param {string|undefined} action get|set|reset|path
 * @param {string|undefined} key
 * @param {string|undefined} value
 * @param {object} cmdOpts
 * @returns {Promise<number>}
 */
export async function configCommand(ctx, action, key, value, cmdOpts = {}) {
  switch (action || 'get') {
    case 'get':
      return configGet(ctx, key);
    case 'set':
      return configSet(ctx, key, value);
    case 'reset':
      return configReset(ctx, cmdOpts);
    case 'path':
      return configPath(ctx);
    default:
      ctx.fail(`unknown config action "${action}" (use get, set, reset, or path)`);
      return EXIT.USAGE;
  }
}
