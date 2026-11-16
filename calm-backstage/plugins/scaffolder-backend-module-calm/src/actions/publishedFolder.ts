import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';

/** The folder in the scaffolder workspace where a dry run writes what the real run publishes to `localDir`. */
export const DRY_RUN_OUTPUT_DIR = 'dry-run-output';

/**
 * The absolute path of a published service folder. Throws NotAllowedError for a folder outside `localDir`. With
 * `dryRunWorkspace`, a folder inside `<dryRunWorkspace>/dry-run-output` is accepted too.
 */
export function publishedFolder(
  localDir: string,
  dir: string,
  options?: { dryRunWorkspace?: string },
): string {
  const abs = path.resolve(dir);
  if (options?.dryRunWorkspace) {
    const dryRoot = path.join(options.dryRunWorkspace, DRY_RUN_OUTPUT_DIR);
    const rel = path.relative(dryRoot, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return resolveSafeChildPath(dryRoot, rel);
    }
  }
  return resolveSafeChildPath(localDir, path.relative(localDir, abs));
}
