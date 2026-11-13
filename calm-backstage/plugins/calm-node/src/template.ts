import path from 'node:path';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { runCalm } from './cli';
import { listFiles } from './files';

export interface RenderBundleOptions {
  /** Absolute path of the architecture file. */
  architecturePath: string;
  /** Absolute path of the template bundle (the folder holding its `index.json`). */
  bundleDir: string;
  /** Folder the CLI runs in; `outputDir` is relative to it. */
  dir: string;
  /**
   * Output folder relative to `dir`. Every segment must be free of dots: `calm template -o` takes a name with a dot
   * for a file path and writes into the parent.
   */
  outputDir: string;
  logger: LoggerService;
  signal?: AbortSignal;
}

/** Rejects an output folder `calm template -o` would misread, or one outside `dir`. */
export function checkTemplateOutputDir(outputDir: string): string {
  const normal = path.posix.normalize(outputDir.split(path.sep).join('/'));
  const segments = normal.split('/').filter(s => s !== '');
  if (
    !segments.length ||
    path.posix.isAbsolute(normal) ||
    segments.some(s => s === '..' || s.includes('.'))
  ) {
    throw new Error(
      `Output folder must be a relative path without dots in any segment (calm template takes a dotted name for a file), got ${JSON.stringify(
        outputDir,
      )}`,
    );
  }
  return segments.join('/');
}

/**
 * Runs `calm template -a <architecture> -b <bundleDir> -o <outputDir>` in `dir` and returns the rendered files,
 * relative to the output folder. No `--clear-output-directory`: with a misread path it would empty the parent.
 * Rejects when nothing was rendered.
 */
export async function renderBundle(
  opts: RenderBundleOptions,
): Promise<{ outputDir: string; files: string[] }> {
  const outputDir = checkTemplateOutputDir(opts.outputDir);
  const args = [
    'template',
    '-a',
    opts.architecturePath,
    '-b',
    opts.bundleDir,
    '-o',
    outputDir,
  ];
  opts.logger.info(`calm ${args.join(' ')}`);
  await runCalm(args, {
    cwd: opts.dir,
    logger: opts.logger,
    signal: opts.signal,
  });
  const files = await listFiles(path.join(opts.dir, outputDir));
  if (!files.length) {
    throw new Error(
      `calm template rendered no files into ${outputDir} (bundle ${opts.bundleDir})`,
    );
  }
  return { outputDir, files };
}
