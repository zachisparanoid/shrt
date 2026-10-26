import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanInput,
  normalizeUrl,
  validateUrl,
  isPrivateHost,
  isAlreadyShort,
  ValidationError,
} from '../src/validate.js';

test('cleanInput trims whitespace', () => {
  assert.equal(cleanInput('  https://example.com  '), 'https://example.com');
  assert.equal(cleanInput('\thttps://example.com\n'), 'https://example.com');
});

test('cleanInput strips surrounding quotes and angle brackets', () => {
  assert.equal(cleanInput('"https://example.com"'), 'https://example.com');
  assert.equal(cleanInput("'https://example.com'"), 'https://example.com');
  assert.equal(cleanInput('<https://example.com>'), 'https://example.com');
  assert.equal(cleanInput('`https://example.com`'), 'https://example.com');
});

test('normalizeUrl keeps an explicit http/https scheme and reports no note', () => {
  const r = normalizeUrl('https://example.com/a/b');
  assert.equal(r.url, 'https://example.com/a/b');
  assert.equal(r.host, 'example.com');
  assert.equal(r.note, undefined);
});

test('normalizeUrl auto-prepends https:// when scheme is missing', () => {
  const r = normalizeUrl('example.com/x');
  assert.equal(r.url, 'https://example.com/x');
  assert.equal(r.host, 'example.com');
  assert.match(r.note, /https/);
});

test('normalizeUrl treats host:port without scheme as host+port, not a scheme', () => {
  const r = normalizeUrl('example.com:8080/x');
  assert.equal(r.host, 'example.com');
  assert.equal(r.url, 'https://example.com:8080/x');
});

test('normalizeUrl converts IDN/unicode hosts to punycode', () => {
  const r = normalizeUrl('https://münchen.de/straße');
  assert.equal(r.host, 'xn--mnchen-3ya.de');
});

test('normalizeUrl throws ValidationError on unparseable input', () => {
  assert.throws(() => normalizeUrl('http://'), ValidationError);
  assert.throws(() => normalizeUrl(':::'), ValidationError);
});

test('validateUrl accepts a normal public https URL', () => {
  const r = validateUrl('https://example.com/very/long/path');
  assert.equal(r.url, 'https://example.com/very/long/path');
  assert.equal(r.host, 'example.com');
});

test('validateUrl rejects non-http(s) schemes', () => {
  for (const bad of [
    'javascript:alert(1)',
    'ftp://files.example.com/x',
    'file:///etc/passwd',
    'data:text/html,<h1>x</h1>',
  ]) {
    assert.throws(() => validateUrl(bad), ValidationError, `should reject ${bad}`);
  }
});

test('validateUrl SSRF guard blocks loopback / private / link-local / .local hosts', () => {
  const blocked = [
    'http://localhost/x',
    'http://localhost:3000/x',
    'http://127.0.0.1/x',
    'http://127.5.5.5/x',
    'http://10.0.0.1/x',
    'http://172.16.0.1/x',
    'http://172.31.255.255/x',
    'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data', // cloud metadata endpoint
    'http://[::1]/x',
    'https://printer.local/setup',
    'http://0.0.0.0/x',
  ];
  for (const url of blocked) {
    assert.throws(() => validateUrl(url, { allowPrivate: false }), ValidationError, `should block ${url}`);
  }
});

test('validateUrl blocks non-FQDN bare hosts', () => {
  assert.throws(() => validateUrl('http://intranet/x', { allowPrivate: false }), ValidationError);
});

test('validateUrl allows private hosts when allowPrivate is true', () => {
  const r = validateUrl('http://192.168.1.50:8787/abc', { allowPrivate: true });
  assert.equal(r.host, '192.168.1.50');
  // bare host also allowed in local/self-hosted mode
  assert.doesNotThrow(() => validateUrl('http://intranet/x', { allowPrivate: true }));
});

test('validateUrl rejects implausible hosts even in allowPrivate/local mode', () => {
  // garbage like "ht!tp://bad url" must not become a stored link
  assert.throws(() => validateUrl('ht!tp://bad url', { allowPrivate: true }), ValidationError);
  assert.throws(() => validateUrl('https://has space.com', { allowPrivate: true }), ValidationError);
  // but a bare intranet single-label host is still fine when private is allowed
  assert.doesNotThrow(() => validateUrl('http://myhost', { allowPrivate: true }));
});

test('validateUrl allows public IPs', () => {
  const r = validateUrl('http://8.8.8.8/x', { allowPrivate: false });
  assert.equal(r.host, '8.8.8.8');
});

test('ValidationError carries a machine-readable code', () => {
  try {
    validateUrl('http://localhost/x');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.equal(err.code, 'private');
  }
});

test('isPrivateHost classifies hosts correctly', () => {
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('10.1.2.3'), true);
  assert.equal(isPrivateHost('172.20.0.1'), true);
  assert.equal(isPrivateHost('172.32.0.1'), false); // just outside 172.16/12
  assert.equal(isPrivateHost('192.168.0.1'), true);
  assert.equal(isPrivateHost('169.254.1.1'), true);
  assert.equal(isPrivateHost('::1'), true);
  assert.equal(isPrivateHost('printer.local'), true);
  assert.equal(isPrivateHost('example.com'), false);
  assert.equal(isPrivateHost('8.8.8.8'), false);
});

test('isAlreadyShort flags short inputs and known shortener hosts', () => {
  assert.equal(isAlreadyShort('https://is.gd/abc'), true); // known host
  assert.equal(isAlreadyShort('https://tinyurl.com/abcd'), true);
  assert.equal(isAlreadyShort('http://a.co/b'), true); // very short
  assert.equal(isAlreadyShort('https://example.com/a/very/long/path/here/indeed'), false);
});
