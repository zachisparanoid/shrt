import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { copyToClipboard } from '../src/clipboard.js';

/** Build a fake spawn whose child behaves per `behavior(cmd, child)`. */
function fakeSpawn(behavior) {
  const calls = [];
  const impl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    let written = '';
    child.stdin = { write: (s) => (written += s), end: (s) => (written += s ?? '') };
    queueMicrotask(() => behavior(cmd, child, () => written));
    return child;
  };
  impl.calls = calls;
  return impl;
}

test('copyToClipboard succeeds with the first working tool', async () => {
  const spawnImpl = fakeSpawn((cmd, child) => child.emit('close', 0));
  const res = await copyToClipboard('hello', {
    candidates: [{ cmd: 'wl-copy', args: [] }],
    spawnImpl,
  });
  assert.equal(res.ok, true);
  assert.equal(res.tool, 'wl-copy');
});

test('copyToClipboard falls through to the next tool on ENOENT', async () => {
  const spawnImpl = fakeSpawn((cmd, child) => {
    if (cmd === 'wl-copy') {
      const e = new Error('not found');
      e.code = 'ENOENT';
      child.emit('error', e);
    } else {
      child.emit('close', 0);
    }
  });
  const res = await copyToClipboard('hi', {
    candidates: [
      { cmd: 'wl-copy', args: [] },
      { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    ],
    spawnImpl,
  });
  assert.equal(res.ok, true);
  assert.equal(res.tool, 'xclip');
});

test('copyToClipboard returns ok:false when no tool is available', async () => {
  const spawnImpl = fakeSpawn((cmd, child) => {
    const e = new Error('nope');
    e.code = 'ENOENT';
    child.emit('error', e);
  });
  const res = await copyToClipboard('x', {
    candidates: [{ cmd: 'wl-copy', args: [] }],
    spawnImpl,
  });
  assert.equal(res.ok, false);
});
