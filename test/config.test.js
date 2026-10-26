import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULTS,
  resolvePaths,
  validateConfig,
  coerceConfigValue,
  readConfigFile,
  writeConfigFile,
  loadConfig,
  ConfigError,
} from '../src/config.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'shrt-cfg-'));
  return { dir, file: join(dir, 'config.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('DEFAULTS match the documented shape', () => {
  assert.equal(DEFAULTS.mode, 'remote');
  assert.equal(DEFAULTS.provider, 'is.gd');
  assert.deepEqual(DEFAULTS.providerFallback, ['tinyurl', 'cleanuri']);
  assert.equal(DEFAULTS.serverPort, 8787);
  assert.equal(DEFAULTS.codeLength, 7);
  assert.equal(DEFAULTS.timeoutMs, 8000);
  assert.equal(DEFAULTS.color, 'auto');
  assert.equal(DEFAULTS.allowPrivateHosts, false);
});

test('resolvePaths honours XDG_CONFIG_HOME', () => {
  const p = resolvePaths({ XDG_CONFIG_HOME: '/xdg' });
  assert.equal(p.configDir, '/xdg/shrt');
  assert.equal(p.configPath, '/xdg/shrt/config.json');
  assert.equal(p.dbPath, '/xdg/shrt/shrt.db');
  assert.equal(p.pidPath, '/xdg/shrt/server.pid');
  assert.equal(p.logPath, '/xdg/shrt/server.log');
});

test('resolvePaths falls back to ~/.config', () => {
  const p = resolvePaths({ HOME: '/home/zach' });
  assert.equal(p.configDir, '/home/zach/.config/shrt');
});

test('validateConfig accepts the defaults', () => {
  assert.deepEqual(validateConfig(DEFAULTS), []);
});

test('validateConfig reports the offending key for each invalid value', () => {
  const errs = validateConfig({
    mode: 'sideways',
    serverPort: 99999,
    codeLength: 2,
    timeoutMs: 100,
    color: 'rainbow',
    provider: 'bogus',
    localBaseUrl: 'not a url',
  });
  const keys = errs.map((e) => e.key).sort();
  assert.deepEqual(keys, ['codeLength', 'color', 'localBaseUrl', 'mode', 'provider', 'serverPort', 'timeoutMs'].sort());
});

test('coerceConfigValue converts string inputs to typed values', () => {
  assert.equal(coerceConfigValue('serverPort', '9000'), 9000);
  assert.equal(coerceConfigValue('codeLength', '8'), 8);
  assert.equal(coerceConfigValue('copyToClipboard', 'true'), true);
  assert.equal(coerceConfigValue('allowPrivateHosts', '0'), false);
  assert.deepEqual(coerceConfigValue('providerFallback', 'tinyurl, cleanuri'), ['tinyurl', 'cleanuri']);
  assert.equal(coerceConfigValue('mode', 'local'), 'local');
});

test('coerceConfigValue throws ConfigError on bad input or unknown key', () => {
  assert.throws(() => coerceConfigValue('serverPort', 'abc'), ConfigError);
  assert.throws(() => coerceConfigValue('mode', 'nope'), ConfigError);
  assert.throws(() => coerceConfigValue('wat', 'x'), ConfigError);
});

test('readConfigFile handles missing files gracefully', () => {
  const { dir, file, cleanup } = tmp();
  try {
    const r = readConfigFile(join(dir, 'does-not-exist.json'));
    assert.equal(r.exists, false);
    assert.equal(r.error, null);
    assert.deepEqual(r.parsed, {});
    void file;
  } finally {
    cleanup();
  }
});

test('readConfigFile reports malformed JSON without throwing', () => {
  const { file, cleanup } = tmp();
  try {
    writeFileSync(file, '{ not valid json ');
    const r = readConfigFile(file);
    assert.ok(r.error);
    assert.deepEqual(r.parsed, {});
  } finally {
    cleanup();
  }
});

test('writeConfigFile + readConfigFile round-trips', () => {
  const { file, cleanup } = tmp();
  try {
    writeConfigFile(file, { mode: 'local', serverPort: 9001 });
    const r = readConfigFile(file);
    assert.equal(r.parsed.mode, 'local');
    assert.equal(r.parsed.serverPort, 9001);
  } finally {
    cleanup();
  }
});

test('loadConfig merges defaults < file < env < flags with source tracking', () => {
  const { file, cleanup } = tmp();
  try {
    writeConfigFile(file, { mode: 'local', serverPort: 9001, codeLength: 9 });
    const { config, sources } = loadConfig({
      configPath: file,
      env: { SHRT_SERVER_PORT: '9002' },
      overrides: { codeLength: 10 },
    });
    assert.equal(config.mode, 'local'); // from file
    assert.equal(config.serverPort, 9002); // env beats file
    assert.equal(config.codeLength, 10); // flag beats env/file
    assert.equal(config.provider, 'is.gd'); // default
    assert.equal(sources.mode, 'file');
    assert.equal(sources.serverPort, 'env');
    assert.equal(sources.codeLength, 'flag');
    assert.equal(sources.provider, 'default');
  } finally {
    cleanup();
  }
});

test('loadConfig falls back to defaults (with a warning) on malformed file', () => {
  const { file, cleanup } = tmp();
  try {
    writeFileSync(file, 'totally broken');
    const { config, warnings } = loadConfig({ configPath: file, env: {} });
    assert.equal(config.mode, 'remote');
    assert.ok(warnings.length >= 1);
  } finally {
    cleanup();
  }
});

test('loadConfig ignores an invalid file value (keeps default) and warns', () => {
  const { file, cleanup } = tmp();
  try {
    writeConfigFile(file, { serverPort: 999999 });
    const { config, warnings } = loadConfig({ configPath: file, env: {} });
    assert.equal(config.serverPort, 8787); // default kept
    assert.ok(warnings.some((w) => /serverPort/.test(w)));
  } finally {
    cleanup();
  }
});

test('loadConfig throws ConfigError on an invalid flag override', () => {
  const { file, cleanup } = tmp();
  try {
    writeConfigFile(file, {});
    assert.throws(() => loadConfig({ configPath: file, env: {}, overrides: { mode: 'bogus' } }), ConfigError);
  } finally {
    cleanup();
  }
});
