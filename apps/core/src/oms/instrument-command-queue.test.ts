import { describe, expect, it } from 'vitest';

import { InstrumentCommandQueue } from './instrument-command-queue.js';

describe('InstrumentCommandQueue', () => {
  it('serializes operations for one instrument and allows other instruments independently', async () => {
    const queue = new InstrumentCommandQueue();
    const trace: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run('instrument-a', async () => {
      trace.push('a1-start');
      await gate;
      trace.push('a1-end');
    });
    const second = queue.run('instrument-a', async () => {
      trace.push('a2');
    });
    const independent = queue.run('instrument-b', async () => {
      trace.push('b1');
    });

    await independent;
    expect(trace).toEqual(['a1-start', 'b1']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(trace).toEqual(['a1-start', 'b1', 'a1-end', 'a2']);
  });
});
