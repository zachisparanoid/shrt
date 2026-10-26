/**
 * End-to-end: spawn the real bin/shrt.js binary against a local stub provider
 * server (via the SHRT_*_ENDPOINT overrides) and a real `serve` subprocess.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shrt.js');

let stub;
let stubPort;
let configHome;
let counter = 0;

before(async () => {
  configHome = mkdtempSync(join(tmpdir(), 'shrt-e2e-'));
  stub = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/isgd-ok') return res.end(`https://stub.tld/I${++counter}`);
    if (u.pathname === '/isgd-fail') return res.end('Error: simulated outage');
    if (u.pathname === '/tiny') return res.end(`https://stub.tld/T${++counter}`);
    if (u.pathname === '/redir') {
      res.writeHead(302, { location: 'https://example.com/final-destination' });
      return res.end();
    }
    res.writeHead(404);
    res.end('nope');
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  stubPort = stub.address().port;
});

after(async () => {
  await new Promise((r) => stub.close(r));
  rmSync(configHome, { recursive: true, force: true });
});

/** Run the CLI as a child process. Always closes stdin so it never hangs. */
function runCli(args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, NO_COLOR: '1', XDG_CONFIG_HOME: configHome, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

/** Start `serve --port 0`, resolve once it prints the bound port. */
function startServe(extraEnv = {}) {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', '0'], {
    env: { ...process.env, NO_COLOR: '1', XDG_CONFIG_HOME: configHome, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (d) => {
      out += d;
      const m = out.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        child.stdout.off('data', onData);
        resolve({ child, port: Number(m[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', () => reject(new Error(`serve exited early: ${out}`)));
    setTimeout(() => reject(new Error(`serve start timeout: ${out}`)), 8000);
  });
}

const isgdOk = () => ({ SHRT_ISGD_ENDPOINT: `http://127.0.0.1:${stubPort}/isgd-ok` });
const isgdFail = () => ({
  SHRT_ISGD_ENDPOINT: `http://127.0.0.1:${stubPort}/isgd-fail`,
  SHRT_TINYURL_ENDPOINT: `http://127.0.0.1:${stubPort}/tiny`,
});

test('remote shorten via stub provider (quiet)', async () => {
  const r = await runCli(['-q', 'https://e2e-remote.example.com/a'], { env: isgdOk() });
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^https:\/\/stub\.tld\/I\d+$/);
});

test('remote provider fallback: is.gd fails → tinyurl wins (JSON)', async () => {
  const r = await runCli(['-j', 'https://e2e-fallback.example.com/a'], { env: isgdFail() });
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed[0].provider, 'tinyurl');
  assert.match(parsed[0].shortUrl, /^https:\/\/stub\.tld\/T\d+$/);
});

test('shorten from stdin (pipe)', async () => {
  const r = await runCli(['-q'], { env: isgdOk(), input: 'https://e2e-stdin.example.com/x\n' });
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^https:\/\/stub\.tld\//);
});

test('batch from stdin with one invalid → partial success exit code 2', async () => {
  const r = await runCli([], {
    env: isgdOk(),
    input: 'https://e2e-batch1.example.com/a\njavascript:alert(1)\n',
  });
  assert.equal(r.code, 2);
});

test('local shorten composes a localhost short URL', async () => {
  const r = await runCli(['-m', 'local', '-q', 'https://e2e-local.example.com/p']);
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^http:\/\/localhost:8787\/[0-9a-z]+$/);
});

test('invalid-only input exits 1', async () => {
  const r = await runCli(['-m', 'local', 'javascript:alert(1)']);
  assert.equal(r.code, 1);
});

test('no input (empty stdin, no args) exits 64 with usage', async () => {
  const r = await runCli([], { input: '' });
  assert.equal(r.code, 64);
  assert.match(r.stderr, /Usage/i);
});

test('alias collision for a different URL errors without --force', async () => {
  await runCli(['-m', 'local', '--alias', 'collide', 'https://e2e-one.example.com/']);
  const r = await runCli(['-m', 'local', '--alias', 'collide', 'https://e2e-two.example.com/']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already taken/i);
});

test('local serve: redirect works, increments hits, expand + delete round-trip', async () => {
  // 1. create a local alias
  const made = await runCli(['-m', 'local', '--alias', 'served', 'https://e2e-served.example.com/dest']);
  assert.equal(made.code, 0);

  // 2. start the server and hit the code
  const { child, port } = await startServe();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/served`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://e2e-served.example.com/dest');

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }

  // 3. stats reflects the hit (written by the serve process, read here via WAL)
  const stats = await runCli(['stats', 'served']);
  assert.equal(stats.code, 0);
  assert.match(stats.stdout, /hits\D+1/);

  // 4. expand resolves locally without network
  const exp = await runCli(['expand', 'served']);
  assert.equal(exp.code, 0);
  assert.match(exp.stdout, /e2e-served\.example\.com\/dest/);

  // 5. delete, then the code is gone
  const del = await runCli(['delete', 'served', '--yes']);
  assert.equal(del.code, 0);
  const after = await runCli(['stats', 'served']);
  assert.equal(after.code, 1);
});

test('expand follows a remote redirect to the final destination', async () => {
  const r = await runCli(['expand', `http://127.0.0.1:${stubPort}/redir`, '--allow-private']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /example\.com\/final-destination/);
});

test('config set persists and is read back; invalid value is rejected', async () => {
  const set = await runCli(['config', 'set', 'codeLength', '9']);
  assert.equal(set.code, 0);
  const get = await runCli(['config', 'get', 'codeLength']);
  assert.equal(get.stdout.trim(), '9');
  const bad = await runCli(['config', 'set', 'codeLength', '99']);
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /codeLength/);
});

test('--version and --help exit 0', async () => {
  const v = await runCli(['--version']);
  assert.equal(v.code, 0);
  assert.match(v.stdout, /\d+\.\d+\.\d+/);
  const h = await runCli(['--help']);
  assert.equal(h.code, 0);
  assert.match(h.stdout, /Examples:/);
});
