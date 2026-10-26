/**
 * Configuration: defaults, XDG paths, file load/save, env mapping, and the
 * precedence merge (flags > env > config file > defaults).
 *
 * Invalid values from the file or environment are skipped (with a warning) so a
 * single bad key never crashes the tool; invalid CLI flags are hard errors.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROVIDER_NAMES } from './constants.js';

/** @typedef {'local'|'remote'} Mode */

/** Default configuration. Every key here is a valid value. */
export const DEFAULTS = Object.freeze({
  mode: 'remote',
  provider: 'is.gd',
  providerFallback: ['tinyurl', 'cleanuri'],
  localBaseUrl: 'http://localhost:8787',
  serverPort: 8787,
  codeLength: 7,
  timeoutMs: 8000,
  color: 'auto',
  copyToClipboard: false,
  allowPrivateHosts: false,
});

/** Thrown for invalid configuration, carrying the offending key. */
export class ConfigError extends Error {
  /** @param {string} message @param {{ key?: string }} [opts] */
  constructor(message, { key } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.key = key;
  }
}

/** SHRT_* env var → config key. */
const ENV_MAP = {
  SHRT_MODE: 'mode',
  SHRT_PROVIDER: 'provider',
  SHRT_PROVIDER_FALLBACK: 'providerFallback',
  SHRT_LOCAL_BASE_URL: 'localBaseUrl',
  SHRT_SERVER_PORT: 'serverPort',
  SHRT_CODE_LENGTH: 'codeLength',
  SHRT_TIMEOUT_MS: 'timeoutMs',
  SHRT_COLOR: 'color',
  SHRT_COPY_TO_CLIPBOARD: 'copyToClipboard',
  SHRT_ALLOW_PRIVATE_HOSTS: 'allowPrivateHosts',
};

const NUMBER_KEYS = new Set(['serverPort', 'codeLength', 'timeoutMs']);
const BOOLEAN_KEYS = new Set(['copyToClipboard', 'allowPrivateHosts']);
const ARRAY_KEYS = new Set(['providerFallback']);

/**
 * Resolve all on-disk paths, honouring XDG_CONFIG_HOME.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolvePaths(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  const configDir = join(base, 'shrt');
  return {
    configDir,
    configPath: join(configDir, 'config.json'),
    dbPath: join(configDir, 'shrt.db'),
    pidPath: join(configDir, 'server.pid'),
    logPath: join(configDir, 'server.log'),
  };
}

/** True if `v` is an integer within [min, max]. */
function isIntInRange(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Validate a (possibly partial) config object.
 * @param {Record<string, unknown>} obj
 * @param {{ strict?: boolean }} [opts] strict also rejects unknown keys
 * @returns {Array<{ key: string, message: string }>}
 */
export function validateConfig(obj, { strict = false } = {}) {
  const errors = [];
  const add = (key, message) => errors.push({ key, message });

  for (const [key, value] of Object.entries(obj)) {
    if (!(key in DEFAULTS)) {
      if (strict) add(key, `unknown config key: ${key}`);
      continue;
    }
    switch (key) {
      case 'mode':
        if (value !== 'local' && value !== 'remote') add(key, "mode must be 'local' or 'remote'");
        break;
      case 'provider':
        if (!PROVIDER_NAMES.includes(value)) add(key, `provider must be one of: ${PROVIDER_NAMES.join(', ')}`);
        break;
      case 'providerFallback':
        if (!Array.isArray(value) || value.some((p) => !PROVIDER_NAMES.includes(p))) {
          add(key, `providerFallback must be an array of: ${PROVIDER_NAMES.join(', ')}`);
        }
        break;
      case 'localBaseUrl':
        try {
          const u = new URL(String(value));
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
        } catch {
          add(key, 'localBaseUrl must be a valid http(s) URL');
        }
        break;
      case 'serverPort':
        if (!isIntInRange(value, 1, 65535)) add(key, 'serverPort must be an integer 1–65535');
        break;
      case 'codeLength':
        if (!isIntInRange(value, 4, 16)) add(key, 'codeLength must be an integer 4–16');
        break;
      case 'timeoutMs':
        if (!isIntInRange(value, 1000, 60000)) add(key, 'timeoutMs must be an integer 1000–60000');
        break;
      case 'color':
        if (!['auto', 'always', 'never'].includes(value)) add(key, "color must be 'auto', 'always', or 'never'");
        break;
      case 'copyToClipboard':
      case 'allowPrivateHosts':
        if (typeof value !== 'boolean') add(key, `${key} must be a boolean`);
        break;
      default:
        break;
    }
  }
  return errors;
}

/**
 * Coerce a raw string (env value or `config set` argument) to its typed value,
 * then validate it. Throws ConfigError naming the key on failure.
 * @param {string} key
 * @param {string} raw
 * @returns {unknown}
 */
export function coerceConfigValue(key, raw) {
  if (!(key in DEFAULTS)) throw new ConfigError(`unknown config key: ${key}`, { key });

  let value;
  if (NUMBER_KEYS.has(key)) {
    if (!/^-?\d+$/.test(String(raw).trim())) throw new ConfigError(`${key} must be an integer`, { key });
    value = Number.parseInt(String(raw), 10);
  } else if (BOOLEAN_KEYS.has(key)) {
    const s = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) value = true;
    else if (['false', '0', 'no', 'off'].includes(s)) value = false;
    else throw new ConfigError(`${key} must be a boolean (true/false)`, { key });
  } else if (ARRAY_KEYS.has(key)) {
    value = String(raw)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    value = String(raw).trim();
  }

  const errs = validateConfig({ [key]: value });
  if (errs.length) throw new ConfigError(errs[0].message, { key });
  return value;
}

/**
 * Read and parse the config file. Never throws: returns a structured result so
 * a malformed file degrades to defaults.
 * @param {string} configPath
 * @returns {{ parsed: Record<string, unknown>, error: string|null, exists: boolean }}
 */
export function readConfigFile(configPath) {
  if (!existsSync(configPath)) return { parsed: {}, error: null, exists: false };
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    return { parsed: {}, error: `cannot read ${configPath}: ${err.message}`, exists: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { parsed: {}, error: `${configPath} is not a JSON object`, exists: true };
    }
    return { parsed, error: null, exists: true };
  } catch (err) {
    return { parsed: {}, error: `invalid JSON in ${configPath}: ${err.message}`, exists: true };
  }
}

/** Write a config object as pretty JSON, creating the directory if needed. */
export function writeConfigFile(configPath, obj) {
  const dir = dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/**
 * Extract config overrides from environment variables.
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ values: Record<string, unknown>, warnings: string[] }}
 */
function envOverrides(env) {
  const values = {};
  const warnings = [];
  for (const [envKey, cfgKey] of Object.entries(ENV_MAP)) {
    if (env[envKey] === undefined || env[envKey] === '') continue;
    try {
      values[cfgKey] = coerceConfigValue(cfgKey, env[envKey]);
    } catch (err) {
      warnings.push(`ignoring ${envKey}: ${err.message}`);
    }
  }
  return { values, warnings };
}

/**
 * Build the resolved config with precedence flags > env > file > defaults.
 * @param {object} opts
 * @param {string} opts.configPath
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {Record<string, unknown>} [opts.overrides] CLI flag values (already typed)
 * @returns {{ config: Record<string, unknown>, sources: Record<string,string>, warnings: string[] }}
 * @throws {ConfigError} when a flag override is invalid
 */
export function loadConfig({ configPath, env = process.env, overrides = {} }) {
  const config = { ...DEFAULTS };
  const sources = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, 'default']));
  const warnings = [];

  // ── file layer ──
  const file = readConfigFile(configPath);
  if (file.error) {
    warnings.push(`${file.error} — using defaults`);
  } else {
    for (const [key, value] of Object.entries(file.parsed)) {
      if (!(key in DEFAULTS)) {
        warnings.push(`ignoring unknown config key "${key}" in ${configPath}`);
        continue;
      }
      const errs = validateConfig({ [key]: value });
      if (errs.length) {
        warnings.push(`ignoring invalid config "${key}" in file: ${errs[0].message}`);
        continue;
      }
      config[key] = value;
      sources[key] = 'file';
    }
  }

  // ── env layer ──
  const { values: envValues, warnings: envWarnings } = envOverrides(env);
  warnings.push(...envWarnings);
  for (const [key, value] of Object.entries(envValues)) {
    config[key] = value;
    sources[key] = 'env';
  }

  // ── flag layer (hard errors) ──
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    if (!(key in DEFAULTS)) continue;
    config[key] = value;
    sources[key] = 'flag';
  }
  const flagErrors = validateConfig(config);
  if (flagErrors.length) {
    // Only surface errors that came from flags (file/env were already filtered).
    const e = flagErrors[0];
    throw new ConfigError(`invalid value for ${e.key}: ${e.message}`, { key: e.key });
  }

  return { config, sources, warnings };
}
