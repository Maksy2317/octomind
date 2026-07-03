import fs from 'fs';
import path from 'path';

/**
 * Deletes files older than `maxAgeMs` from the given directories.
 * Never throws — every failure is logged and skipped so a bad file can't stop
 * the server or abort the rest of the sweep.
 */
export function cleanupOldFiles(dirs: string[], maxAgeMs: number): void {
  const now = Date.now();

  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // Directory may not exist yet — not fatal.
      console.warn(`[Cleanup] Cannot read dir ${dir}:`, (e as Error).message);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue; // skip sub-dirs (e.g. output/) and others
      const filePath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(filePath);
        const age = now - stat.mtimeMs;
        if (age > maxAgeMs) {
          fs.unlinkSync(filePath);
          console.log(`[Cleanup] Removed stale file (${Math.round(age / 3_600_000)}h old): ${entry.name}`);
        }
      } catch (e) {
        console.warn(`[Cleanup] Failed to process ${filePath}:`, (e as Error).message);
      }
    }
  }
}
