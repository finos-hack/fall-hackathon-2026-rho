import path from 'node:path';
import {
  DRY_RUN_OUTPUT_DIR,
  isDryRunFolder,
  publishedFolder,
} from './publishedFolder';

const ws = path.resolve('/tmp/ws');
const localDir = path.join(ws, 'output');

describe('publishedFolder', () => {
  it('accepts a folder inside localDir and refuses others without the option', () => {
    expect(publishedFolder(localDir, path.join(localDir, 'orders'))).toBe(
      path.join(localDir, 'orders'),
    );
    expect(() =>
      publishedFolder(localDir, path.join(ws, DRY_RUN_OUTPUT_DIR, 'orders')),
    ).toThrow();
  });

  it('accepts a folder inside <ws>/dry-run-output with dryRunWorkspace', () => {
    const dir = path.join(ws, DRY_RUN_OUTPUT_DIR, 'orders');
    expect(publishedFolder(localDir, dir, { dryRunWorkspace: ws })).toBe(dir);
  });

  it('still accepts localDir folders with dryRunWorkspace', () => {
    const dir = path.join(localDir, 'orders');
    expect(publishedFolder(localDir, dir, { dryRunWorkspace: ws })).toBe(dir);
  });

  it('refuses other places in the workspace and outside it', () => {
    for (const dir of [
      path.join(ws, 'x'),
      path.join(ws, 'x', 'orders'),
      path.join(ws, DRY_RUN_OUTPUT_DIR, '..', 'x'),
      path.resolve('/tmp/elsewhere/orders'),
    ]) {
      expect(() =>
        publishedFolder(localDir, dir, { dryRunWorkspace: ws }),
      ).toThrow();
    }
  });
});

describe('isDryRunFolder', () => {
  it('is true only for a folder inside <ws>/dry-run-output', () => {
    expect(
      isDryRunFolder(path.join(ws, DRY_RUN_OUTPUT_DIR, 'orders'), ws),
    ).toBe(true);
    for (const dir of [
      path.join(localDir, 'orders'),
      path.join(ws, DRY_RUN_OUTPUT_DIR),
      path.join(ws, DRY_RUN_OUTPUT_DIR, '..', 'x'),
      path.join(ws, 'x', 'orders'),
    ]) {
      expect(isDryRunFolder(dir, ws)).toBe(false);
    }
  });
});
