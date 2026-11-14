import fs from 'node:fs/promises';
import path from 'node:path';

/** Every file under `dir`, as sorted paths relative to it (forward slashes). An absent folder gives an empty list. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw e;
    }
    for (const ent of entries) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
      } else if (ent.isFile()) {
        out.push(path.relative(dir, p).split(path.sep).join('/'));
      }
    }
  };
  await walk(dir);
  return out.sort();
}
