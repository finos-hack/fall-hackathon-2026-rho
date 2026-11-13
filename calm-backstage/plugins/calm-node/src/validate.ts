import fs from 'node:fs/promises';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { CalmCliError, runCalm } from './cli';

/** One message of `calm validate -f json` (both the JSON schema and the Spectral outputs have this shape). */
export interface ValidationMessage {
  code?: string;
  severity: string;
  message: string;
  path?: string;
  source?: string;
}

export interface ValidateArchitectureOptions {
  /** Pattern URL in CALM Hub (the pattern `$id`). */
  patternUrl: string;
  /** Absolute path of the architecture file. */
  architecturePath: string;
  /** CALM Hub base URL (`-c`): without it, control URLs on localhost are refused as private addresses. */
  hubUrl: string;
  /** Folder the CLI runs in. */
  dir: string;
  /** Absolute path the JSON report is written to (`-o`). */
  outputPath: string;
  logger: LoggerService;
  signal?: AbortSignal;
}

export interface ValidateArchitectureResult {
  hasErrors: boolean;
  hasWarnings: boolean;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  /** The full JSON report. */
  report: any;
}

/**
 * Runs `calm validate -p <patternUrl> -a <architecture> -c <hubUrl> -f json -o <outputPath>` and reads the report.
 * The CLI exits 1 when the report has errors; the report is still written, so that case resolves with
 * `hasErrors: true`. Any other failure (no report written) rejects with the CLI error.
 */
export async function validateArchitecture(
  opts: ValidateArchitectureOptions,
): Promise<ValidateArchitectureResult> {
  await fs.rm(opts.outputPath, { force: true });
  const args = [
    'validate',
    '-p',
    opts.patternUrl,
    '-a',
    opts.architecturePath,
    '-c',
    opts.hubUrl,
    '-f',
    'json',
    '-o',
    opts.outputPath,
  ];
  opts.logger.info(`calm ${args.join(' ')}`);
  let cliError: CalmCliError | undefined;
  try {
    await runCalm(args, {
      cwd: opts.dir,
      logger: opts.logger,
      signal: opts.signal,
    });
  } catch (e) {
    if (!(e instanceof CalmCliError)) {
      throw e;
    }
    cliError = e;
  }

  let report: any;
  try {
    report = JSON.parse(await fs.readFile(opts.outputPath, 'utf8'));
  } catch {
    if (cliError) {
      throw cliError;
    }
    throw new Error(`calm validate wrote no report to ${opts.outputPath}`);
  }
  const messages: ValidationMessage[] = [
    ...(report.jsonSchemaValidationOutputs ?? []),
    ...(report.spectralSchemaValidationOutputs ?? []),
  ];
  const errors = messages.filter(m => m.severity === 'error');
  const warnings = messages.filter(m => m.severity === 'warning');
  const hasErrors = Boolean(report.hasErrors) || errors.length > 0;
  if (cliError && !hasErrors) {
    // A non-zero exit with a clean report: not a validation result we understand.
    throw cliError;
  }
  return {
    hasErrors,
    hasWarnings: Boolean(report.hasWarnings) || warnings.length > 0,
    errors,
    warnings,
    report,
  };
}
