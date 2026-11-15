import path from 'node:path';

/**
 * How long a service's working copy stays reserved for the task that took it. A task that fails between steps (the
 * image build, say) cannot always release it, so the reservation ends by itself.
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
    private readonly ttlMs = SERVICE_LOCK_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reserves `dir` for `owner`, or throws when another task holds it. */
  acquire(dir: string, owner: string): void {
    const key = path.resolve(dir);
    const current = this.held.get(key);
    if (current && current.owner !== owner && current.until > this.now()) {
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

  /** Releases `dir` if `owner` holds it. */
  release(dir: string, owner: string): void {
    const key = path.resolve(dir);
    if (this.held.get(key)?.owner === owner) {
      this.held.delete(key);
    }
  }

  /** The task that holds `dir`, if any. */
  holder(dir: string): string | undefined {
    const current = this.held.get(path.resolve(dir));
    return current && current.until > this.now() ? current.owner : undefined;
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
 * - `dir` is the working copy, from the input.
 * - The reservation is released when the body fails. When it succeeds, `keep` says whether the task goes on in the
 *   same working copy (an upgrade after its render, until its deploy), judged by what the body output; the default
 *   is to release.
 * - `acquire: false` only releases on failure, for a step that works in a copy another step reserved.
 */
export async function withServiceLock<C extends LockContext>(
  ctx: C,
  options: {
    dir: string;
    keep?: (outputs: Record<string, unknown>) => boolean;
    acquire?: boolean;
    locks?: ServiceLocks;
  },
  run: (ctx: C) => Promise<void>,
): Promise<void> {
  const locks = options.locks ?? serviceLocks;
  const owner = ctx.task?.id ?? 'unknown-task';
  if (options.acquire !== false) {
    locks.acquire(options.dir, owner);
  }
  const outputs: Record<string, unknown> = {};
  const seen = Object.create(ctx) as C;
  seen.output = ((name: string, value: unknown) => {
    outputs[name] = value;
    ctx.output(name, value);
  }) as C['output'];
  let kept = false;
  try {
    await run(seen);
    kept = options.keep?.(outputs) ?? false;
  } finally {
    if (!kept) {
      locks.release(options.dir, owner);
    }
  }
}
