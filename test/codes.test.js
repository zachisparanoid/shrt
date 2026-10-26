import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET } from '../src/constants.js';
import { generateCode, isValidAlias, generateUniqueCode, CodeError } from '../src/codes.js';

test('generateCode produces a string of the requested length', () => {
  assert.equal(generateCode(7).length, 7);
  assert.equal(generateCode(4).length, 4);
  assert.equal(generateCode(12).length, 12);
});

test('generateCode defaults to length 7', () => {
  assert.equal(generateCode().length, 7);
});

test('generateCode only uses the unambiguous alphabet', () => {
  const alphabet = new Set(CODE_ALPHABET.split(''));
  for (let i = 0; i < 200; i++) {
    for (const ch of generateCode(10)) {
      assert.ok(alphabet.has(ch), `unexpected char "${ch}"`);
    }
  }
  // sanity: the spec's excluded ambiguous chars (0/o/1/l) never appear
  const bigSample = Array.from({ length: 100 }, () => generateCode(16)).join('');
  for (const ambiguous of ['0', 'o', '1', 'l']) {
    assert.ok(!bigSample.includes(ambiguous), `alphabet leaked "${ambiguous}"`);
  }
});

test('isValidAlias accepts URL-safe user codes (including letters excluded from the gen alphabet)', () => {
  assert.equal(isValidAlias('mylink'), true); // contains l & o, fine for user aliases
  assert.equal(isValidAlias('go'), true);
  assert.equal(isValidAlias('My-Link_2024'), true);
  assert.equal(isValidAlias('a'), true);
});

test('isValidAlias rejects bad aliases', () => {
  assert.equal(isValidAlias('has/slash'), false);
  assert.equal(isValidAlias('has space'), false);
  assert.equal(isValidAlias(''), false);
  assert.equal(isValidAlias('a'.repeat(65)), false);
  assert.equal(isValidAlias('white.dot'), false);
  assert.equal(isValidAlias('healthz'), false); // reserved (server route)
});

test('generateUniqueCode returns a code that passes the exists() check', () => {
  const taken = new Set(['aaaaaaa', 'bbbbbbb']);
  const code = generateUniqueCode({ length: 7, exists: (c) => taken.has(c) });
  assert.equal(taken.has(code), false);
  assert.equal(code.length, 7);
});

test('generateUniqueCode bumps length when the base length is saturated', () => {
  // Pretend every length-7 code is taken; only length-8 is free.
  const code = generateUniqueCode({
    length: 7,
    exists: (c) => c.length === 7,
    maxAttempts: 5,
  });
  assert.equal(code.length, 8);
});

test('generateUniqueCode throws CodeError when it cannot find a free code', () => {
  assert.throws(
    () => generateUniqueCode({ length: 7, exists: () => true, maxAttempts: 3, maxLength: 9 }),
    CodeError,
  );
});
