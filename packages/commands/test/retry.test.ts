import { describe, expect, it } from 'vitest';
import { retrySnapshotConflicts } from '../src/registry';

// A deadlock victim's transaction was rolled back whole, so the executor runs the command again
// rather than answering with an internal error; if it keeps losing, the caller is told to retry.

const deadlock = () =>
  Object.assign(new Error('query failed'), { cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }) });

describe('retrying a transaction', () => {
  it('runs a write again after a deadlock', async () => {
    let attempts = 0;
    const result = await retrySnapshotConflicts(false, async () => {
      if (++attempts < 3) throw deadlock();
      return 'done';
    });
    expect(result).toBe('done');
    expect(attempts).toBe(3);
  });

  it('answers with a conflict when the deadlock keeps happening', async () => {
    let attempts = 0;
    await expect(
      retrySnapshotConflicts(false, async () => {
        attempts++;
        throw deadlock();
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(attempts).toBe(3);
  });

  it('does not retry other failures of a write', async () => {
    let attempts = 0;
    await expect(
      retrySnapshotConflicts(false, async () => {
        attempts++;
        throw Object.assign(new Error('serialization'), { code: '40001' });
      }),
    ).rejects.toThrow('serialization');
    expect(attempts).toBe(1);
  });
});
