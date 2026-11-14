import path from 'node:path';
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';

/** The absolute path of a published service folder. Throws NotAllowedError for a folder outside `localDir`. */
export function publishedFolder(localDir: string, dir: string): string {
  return resolveSafeChildPath(
    localDir,
    path.relative(localDir, path.resolve(dir)),
  );
}
