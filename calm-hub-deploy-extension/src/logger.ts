import type { KubernetesRunOptions } from '@internal/backstage-plugin-calm-node';

/** The logger shape the calm-node helpers take (Backstage's LoggerService, of which they use only these methods). */
export type Logger = KubernetesRunOptions['logger'];

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** A plain console logger: `<time> <level> [<scope>] message {meta}`. */
export function createLogger(
  scope = 'gitops-deploy',
  minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info',
  sink: (line: string) => void = line => process.stdout.write(`${line}\n`),
): Logger {
  const log =
    (level: Level) =>
    (message: string, meta?: unknown): void => {
      if (ORDER[level] < ORDER[minLevel]) return;
      const extra = meta && typeof meta === 'object' && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      sink(`${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${message}${extra}`);
    };
  const logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (meta: Record<string, unknown>) =>
      createLogger(typeof meta?.scope === 'string' ? `${scope}/${meta.scope}` : scope, minLevel, sink),
  };
  return logger as unknown as Logger;
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = createLogger('silent', 'error', () => {});
