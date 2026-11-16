import { describe, expect, it } from 'vitest';
import { RunWalker } from '../../../src/engine/playbook/walker.js';

describe('RunWalker', () => {
  it('runs one advance per kick and ignores a second kick until it settles', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const walker = new RunWalker({
      async advance() { calls += 1; await gate; },
    });
    walker.kick('run-1');
    walker.kick('run-1');
    await Promise.resolve();
    expect(calls).toBe(1);
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    walker.kick('run-1');
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  it('swallows a rejected advance and lets a later kick run', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    let calls = 0;
    const walker = new RunWalker({
      async advance() {
        calls += 1;
        if (calls === 1) throw new Error('advance failed');
      },
    });
    try {
      walker.kick('run-1');
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      walker.kick('run-1');
      await new Promise((resolve) => setImmediate(resolve));
      expect(calls).toBe(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});