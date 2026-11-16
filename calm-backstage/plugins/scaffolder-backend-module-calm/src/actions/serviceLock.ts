import path from 'node:path';

/**
 * How long a service's working copy stays reserved for the task that took it, counted from the last time a step of
 * that task worked in it. A task that fails between steps (or is killed) cannot always release it, so it ends by
 * itself.
 */
export const SERVICE_LOCK_TTL_MS = 10 * 60 * 1000;

interface Held {
  owner: string;
  until: number;
}

/**
 * Who is working in a service's working copy (`output/<name>`). `calm:upgrade:render`, `calm:upgrade:merge` and
 * `calm:deploy:gitops` reset, clean and switch branches in it, and an upgrade spans several steps (render, build,
 * merge, deploy), so two tasks for the same service must not interleave. The reservation belongs to a task: the same
 * task may take it again, another one is refused until it is released or runs out. In memory, like the backend.
 */
export class ServiceLocks {
  private readonly held = new Map<string, Held>();

  constructor(
    readonly ttlMs = SERVICE_LOCK_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Drops the reservations that ran out. */
  private prune(): void {
    const now = this.now();
    for (const [key, h] of this.held) {
      if (h.until <= now) {
        this.held.delete(key);
      }
    }
  }

  /** Reserves `dir` for `owner`, or throws when another task holds it. */
  acquire(dir: string, owner: string): void {
    this.prune();
    const key = path.resolve(dir);
    const current = this.held.get(key);
    if (current && current.owner !== owner) {
      throw new Error(
        `${key} is in use by the task ${
          current.owner
        }, which is upgrading or deploying the same service. Wait for it to finish (a task that failed releases it at the latest at ${new Date(
          current.until,
        ).toISOString()}) and run this one again`,
      );
    }
    this.held.set(key, { owner, until: this.now() + this.ttlMs });
  }

  /** Extends the reservation of `owner` on `dir` from now; does nothing when `owner` does not hold it. */
  renew(dir: string, owner: string): void {
    this.prune();
    const key = path.resolve(dir);
    if (this.held.get(key)?.owner === owner) {
      this.held.set(key, { owner, until: this.now() + this.ttlMs });
    }
  }

  /** Releases `dir` if `owner` holds it. */
  release(dir: string, owner: string): void {
    const key = path.resolve(dir);
    if (this.held.get(key)?.owner === owner) {
      this.held.delete(key);
    }
  }

  /** The task that holds `dir`, if any. */
  holder(dir: string): string | undefined {
    this.prune();
    return this.held.get(path.resolve(dir))?.owner;
  }
}

/** The locks of this backend. */
export const serviceLocks = new ServiceLocks();

/** The part of an action context the lock needs. */
interface LockContext {
  task?: { id: string };
  output: (...args: any[]) => void;
}

/**
 * Runs the body of an action's handler with the service's working copy reserved for its task.
 *
 * - `dir` is the working copy.
 * - The reservation is renewed while the body runs, so a long step (an image build) does not outlast it.
 * - It is released when the body fails. When the body succeeds, `keep` says whether the task goes on in the same
 *   working copy (an upgrade after its render, until its deploy), judged by what the body output; the default is to
 *   release.
 * - `acquire: false` is for a step that works in a copy another step reserved (the image build): it takes nothing,
 *   renews the task's own reservation while it runs, releases it when it fails, and keeps it when it succeeds.
 * - `enabled: false` runs the body as it is, without a task id and without reserving, renewing or releasing anything
 *   (a dry run, whose folder nothing else contends for).
 * - A task id is needed to tell tasks apart: without one this throws rather than let two runs count as the same task.
 */
export async function withServiceLock<C extends LockContext>(
  ctx: C,
  options: {
    dir: string;
    keep?: (outputs: Record<string, unknown>) => boolean;
    acquire?: boolean;
    enabled?: boolean;
    locks?: ServiceLocks;
  },
  run: (ctx: C) => Promise<void>,
): Promise<void> {
  if (options.enabled === false) {
    return run(ctx);
  }
  const locks = options.locks ?? serviceLocks;
  const owner = ctx.task?.id;
  if (!owner) {
    throw new Error(
      `The working copy ${options.dir} is reserved per scaffolder task, but this run has no task id`,
    );
  }
  const takes = options.acquire !== false;
  if (takes) {
    locks.acquire(options.dir, owner);
  }
  const heartbeat = setInterval(
    () => locks.renew(options.dir, owner),
    Math.max(1, Math.floor(locks.ttlMs / 3)),
  );
  heartbeat.unref();
  const outputs: Record<string, unknown> = {};
  const seen = Object.create(ctx) as C;
  seen.output = ((name: string, value: unknown) => {
    outputs[name] = value;
    ctx.output(name, value);
  }) as C['output'];
  let kept = false;
  try {
    await run(seen);
    kept = takes ? options.keep?.(outputs) ?? false : true;
  } finally {
    clearInterval(heartbeat);
    if (kept) {
      locks.renew(options.dir, owner);
    } else {
      locks.release(options.dir, owner);
    }
  }
}
