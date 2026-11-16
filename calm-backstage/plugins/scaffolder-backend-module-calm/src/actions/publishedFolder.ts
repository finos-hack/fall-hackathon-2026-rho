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
  if (
    options?.dryRunWorkspace &&
    isDryRunFolder(abs, options.dryRunWorkspace)
  ) {
    const dryRoot = path.join(options.dryRunWorkspace, DRY_RUN_OUTPUT_DIR);
    return resolveSafeChildPath(dryRoot, path.relative(dryRoot, abs));
  }
  return resolveSafeChildPath(localDir, path.relative(localDir, abs));
}

/**
 * Whether `dir` is inside `<workspacePath>/dry-run-output`, where a dry run may write. A dry run given a folder in
 * `localDir` must not write there.
 */
export function isDryRunFolder(dir: string, workspacePath: string): boolean {
  const rel = path.relative(
    path.join(workspacePath, DRY_RUN_OUTPUT_DIR),
    path.resolve(dir),
  );
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}
