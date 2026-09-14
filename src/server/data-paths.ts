import { resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { getDataDir } from './db.js';

/**
 * Every read from the data directory goes through here.
 *
 * Two loaders used to resolve these paths relative to their own module, which
 * put them at `<repo>/src/data/...` in dev and `/app/dist/.../data/...` in a
 * container — neither of which exists. DM presets therefore never loaded in
 * any environment, and scenario seeding never loaded in production, both
 * failing silently into a fallback. `getDataDir()` is correct in dev, and
 * correct in production because the deployment sets `DATA_DIR` explicitly —
 * but its own fallback (used when `DATA_DIR` is unset) is layout-unaware and
 * reproduces the same bug for a bare `docker run` or a local
 * `npm run build && npm start`. That's why `index.ts` runs a boot-time check
 * that logs loudly if the data directory turns out to be incomplete.
 */
export function dataPath(...segments: string[]): string {
  return resolve(getDataDir(), ...segments);
}

/**
 * Resolve a named file inside a data subdirectory, or null if the name is
 * malformed, escapes the subdirectory, or the file is absent. Callers must
 * treat null as "not available" — never as an empty document.
 */
export function safeDataFile(subdir: string, name: string, ext: string): string | null {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) return null;
  const dir = dataPath(subdir);
  const file = resolve(dir, `${name}${ext}`);
  if (!file.startsWith(dir + sep)) return null;
  if (!existsSync(file)) return null;
  return file;
}
