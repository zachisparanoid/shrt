import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { splitLines, collectUrls, InputError } from '../src/input.js';

test('splitLines trims, handles CRLF, and drops blanks + comments', () => {
  const text = 'https://a.com\r\n  https://b.com  \n\n# a comment\nhttps://c.com\n';
  assert.deepEqual(splitLines(text), ['https://a.com', 'https://b.com', 'https://c.com']);
});

test('collectUrls merges args + file and de-duplicates (stdin ignored when args/file present)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shrt-in-'));
  const file = join(dir, 'urls.txt');
  writeFileSync(file, 'https://file1.com\nhttps://dup.com\n');
  try {
    const urls = await collectUrls({
      args: ['https://arg1.com', 'https://dup.com'],
      filePath: file,
      // stdin must be IGNORED because args/file were supplied (prevents hangs)
      stdin: Readable.from(['https://stdin-ignored.com\n']),
      stdinIsTTY: false,
    });
    assert.deepEqual(urls, ['https://arg1.com', 'https://dup.com', 'https://file1.com']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collectUrls reads stdin only when no args/file are given, stripping quotes', async () => {
  const urls = await collectUrls({
    args: [],
    stdin: Readable.from(['"https://quoted.com"\nhttps://second.com\n']),
    stdinIsTTY: false,
  });
  assert.deepEqual(urls, ['https://quoted.com', 'https://second.com']);
});

test('collectUrls ignores stdin when it is a TTY', async () => {
  const urls = await collectUrls({
    args: ['https://only-arg.com'],
    stdin: Readable.from(['https://should-be-ignored.com\n']),
    stdinIsTTY: true,
  });
  assert.deepEqual(urls, ['https://only-arg.com']);
});

test('collectUrls throws InputError when the file is missing', async () => {
  await assert.rejects(
    () => collectUrls({ args: [], filePath: '/no/such/file.txt', stdinIsTTY: true }),
    (err) => {
      assert.ok(err instanceof InputError);
      assert.equal(err.code, 'noinput');
      return true;
    },
  );
});
