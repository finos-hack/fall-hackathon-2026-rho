import { ServiceLocks, withServiceLock } from './serviceLock';

const DIR = '/output/orders';

function context(task: string | undefined, outputs: Record<string, unknown>) {
  return {
    task: task ? { id: task } : undefined,
    output: (name: string, value: unknown) => {
      outputs[name] = value;
    },
  };
}

describe('ServiceLocks', () => {
  it('refuses a second task while the first holds the working copy', () => {
    const locks = new ServiceLocks();
    locks.acquire(DIR, 'task-a');
    expect(() => locks.acquire(DIR, 'task-b')).toThrow(
      /in use by the task task-a/,
    );
    expect(locks.holder(DIR)).toBe('task-a');
  });

  it('lets the same task take it again, and another task after a release', () => {
    const locks = new ServiceLocks();
    locks.acquire(DIR, 'task-a');
    expect(() => locks.acquire(DIR, 'task-a')).not.toThrow();
    locks.release(DIR, 'task-b');
    expect(locks.holder(DIR)).toBe('task-a');
    locks.release(DIR, 'task-a');
    expect(() => locks.acquire(DIR, 'task-b')).not.toThrow();
  });

  it('keeps services apart', () => {
    const locks = new ServiceLocks();
    locks.acquire('/output/orders', 'task-a');
    expect(() => locks.acquire('/output/billing', 'task-b')).not.toThrow();
  });

  it('lets a task take over after the reservation ran out', () => {
    let now = 1000;
    const locks = new ServiceLocks(500, () => now);
    locks.acquire(DIR, 'task-a');
    now += 499;
    expect(() => locks.acquire(DIR, 'task-b')).toThrow();
    now += 2;
    expect(locks.holder(DIR)).toBeUndefined();
    expect(() => locks.acquire(DIR, 'task-b')).not.toThrow();
  });
});

describe('withServiceLock', () => {
  it('releases when the body succeeds, unless it says to keep', async () => {
    const locks = new ServiceLocks();
    const out: Record<string, unknown> = {};
    await withServiceLock(
      context('task-a', out),
      { dir: DIR, locks },
      async c => c.output('x', 1),
    );
    expect(locks.holder(DIR)).toBeUndefined();
    expect(out).toEqual({ x: 1 });

    await withServiceLock(
      context('task-a', out),
      { dir: DIR, locks, keep: o => o.changed === true },
      async c => c.output('changed', true),
    );
    expect(locks.holder(DIR)).toBe('task-a');
    await expect(
      withServiceLock(context('task-b', {}), { dir: DIR, locks }, async () => {
        throw new Error('must not run');
      }),
    ).rejects.toThrow(/in use by the task task-a/);
  });

  it('releases when nothing changed', async () => {
    const locks = new ServiceLocks();
    await withServiceLock(
      context('task-a', {}),
      { dir: DIR, locks, keep: o => o.changed === true },
      async c => c.output('changed', false),
    );
    expect(locks.holder(DIR)).toBeUndefined();
  });

  it('releases when the body fails, and passes the error on', async () => {
    const locks = new ServiceLocks();
    await withServiceLock(
      context('task-a', {}),
      { dir: DIR, locks, keep: () => true },
      async () => {},
    );
    await expect(
      withServiceLock(context('task-a', {}), { dir: DIR, locks }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(locks.holder(DIR)).toBeUndefined();
  });

  it('with acquire: false, runs without a reservation and still releases the task’s own on failure', async () => {
    const locks = new ServiceLocks();
    locks.acquire(DIR, 'task-a');
    await expect(
      withServiceLock(
        context('task-a', {}),
        { dir: DIR, locks, acquire: false },
        async () => {
          throw new Error('build failed');
        },
      ),
    ).rejects.toThrow('build failed');
    expect(locks.holder(DIR)).toBeUndefined();

    locks.acquire(DIR, 'task-a');
    await withServiceLock(
      context('task-b', {}),
      { dir: DIR, locks, acquire: false },
      async () => {},
    );
    expect(locks.holder(DIR)).toBe('task-a');
  });
});
